import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor } from "../types.js";
import {
  effectiveFlightStatus,
  transitionFlight,
  type FlightStatus,
  type TransitionRejection,
} from "./flight-lifecycle.js";
import type { FlightRepository } from "./flight-repository.js";
import { toFlightView, type FlightView } from "./flight-view.js";

export type OpenFlightResult =
  | { outcome: "opened"; flight: FlightView }
  | { outcome: "not-found" }
  | {
      outcome: "invalid-status";
      currentStatus: FlightStatus;
      reason: TransitionRejection;
    }
  | { outcome: "status-changed"; currentStatus: FlightStatus };

export type OpenFlight = (
  flightId: string,
  actor: Actor,
) => Promise<OpenFlightResult>;

type OpenFlightDependencies = {
  flightRepository: FlightRepository;
  auditRecorder: AuditRecorder;
  transactionRunner: TransactionRunner;
  generateAuditId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * US-FLT-02: SCHEDULED → OPEN. The lifecycle table decides whether the move
 * is legal (BR-FLT-05); changeStatus makes it stick only if nobody changed
 * the flight since it was read — the read and the write are two statements,
 * so without the compare-and-set two admins could both "open" it.
 *
 * No event: no consumer needs one yet.
 */
export function createOpenFlight(
  dependencies: OpenFlightDependencies,
): OpenFlight {
  const {
    flightRepository,
    auditRecorder,
    transactionRunner,
    generateAuditId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (flightId, actor) => {
    if (!isUuid(flightId)) {
      return { outcome: "not-found" };
    }

    const flight = await flightRepository.findById(flightId);

    if (flight === undefined) {
      return { outcome: "not-found" };
    }

    const now = getCurrentTime();
    const currentStatus = effectiveFlightStatus(
      flight.status,
      flight.departureAt,
      now,
    );
    const transition = transitionFlight(currentStatus, "OPEN", {
      departureAt: flight.departureAt,
      now,
    });

    if (!transition.ok) {
      return {
        outcome: "invalid-status",
        currentStatus,
        reason: transition.reason,
      };
    }

    return transactionRunner.run(async () => {
      const changed = await flightRepository.changeStatus(
        flight.id,
        flight.status,
        "OPEN",
      );

      if (changed.outcome === "not-found") {
        return changed;
      }

      if (changed.outcome === "status-changed") {
        return {
          outcome: "status-changed",
          currentStatus: effectiveFlightStatus(
            changed.current,
            flight.departureAt,
            now,
          ),
        } as const;
      }

      const requestId = getRequestId();

      await auditRecorder.record({
        id: generateAuditId(),
        action: "FLIGHT_OPENED",
        actor: { type: "account", id: actor.accountId },
        target: { type: "flight", id: flight.id },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt: now.toISOString(),
        metadata: {
          flightNumber: flight.flightNumber,
          previousStatus: flight.status,
        },
      });

      return {
        outcome: "opened",
        flight: toFlightView({ ...flight, status: "OPEN" }, now),
      } as const;
    });
  };
}
