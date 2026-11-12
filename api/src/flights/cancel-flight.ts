import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { BookingRepository } from "../bookings/booking-repository.js";
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

/**
 * `remainingBookings`: live bookings the cascade has still to cancel when
 * this answer was made (Decision 18) — a snapshot, not a promise.
 */
export type CancelFlightResult =
  | { outcome: "cancelled"; flight: FlightView; remainingBookings: number }
  | { outcome: "already-cancelled"; flight: FlightView; remainingBookings: number }
  | { outcome: "not-found" }
  | {
      outcome: "invalid-status";
      currentStatus: FlightStatus;
      reason: TransitionRejection;
    }
  | { outcome: "status-changed"; currentStatus: FlightStatus };

export type CancelFlight = (
  flightId: string,
  actor: Actor,
) => Promise<CancelFlightResult>;

type CancelFlightDependencies = {
  flightRepository: FlightRepository;
  bookingRepository: BookingRepository;
  auditRecorder: AuditRecorder;
  transactionRunner: TransactionRunner;
  generateAuditId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * US-OPS-01, option B of Decision 18: this transaction changes the flight
 * row and writes its audit entry — nothing else. It must not cancel a
 * booking, release a seat or touch a payment: the cascade job does that,
 * one booking per transaction, so this one locks only the flight row and
 * never waits for a seat a hold has locked (the Day 47 deadlock hypothesis).
 *
 * Once it commits, every hold re-checks the shared on-sale condition against
 * the CANCELLED row and is refused, including a hold queued on the row.
 *
 * Already CANCELLED is success, not 409: a retry after a timeout must not
 * look like a failure. No event: each booking gets its own (Decision 18).
 */
export function createCancelFlight(
  dependencies: CancelFlightDependencies,
): CancelFlight {
  const {
    flightRepository,
    bookingRepository,
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
    const cancelledView = toFlightView({ ...flight, status: "CANCELLED" }, now);
    const remaining = () => bookingRepository.countLiveOnFlight(flight.id, now);

    if (flight.status === "CANCELLED") {
      return {
        outcome: "already-cancelled",
        flight: cancelledView,
        remainingBookings: await remaining(),
      };
    }

    const currentStatus = effectiveFlightStatus(
      flight.status,
      flight.departureAt,
      now,
    );
    const transition = transitionFlight(currentStatus, "CANCELLED", {
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

    const changed = await transactionRunner.run(async () => {
      const result = await flightRepository.changeStatus(
        flight.id,
        flight.status,
        "CANCELLED",
      );

      if (result.outcome !== "changed") {
        return result;
      }

      const requestId = getRequestId();

      await auditRecorder.record({
        id: generateAuditId(),
        action: "FLIGHT_CANCELLED",
        actor: { type: "account", id: actor.accountId },
        target: { type: "flight", id: flight.id },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt: now.toISOString(),
        metadata: {
          flightNumber: flight.flightNumber,
          previousStatus: currentStatus,
        },
      });
      return result;
    });

    if (changed.outcome === "not-found") {
      return changed;
    }

    // Lost the compare-and-set. To another cancel: same end state, so the
    // same success a retry gets. To an open: the admin decides again.
    if (changed.outcome === "status-changed") {
      if (changed.current === "CANCELLED") {
        return {
          outcome: "already-cancelled",
          flight: cancelledView,
          remainingBookings: await remaining(),
        };
      }
      return {
        outcome: "status-changed",
        currentStatus: effectiveFlightStatus(changed.current, flight.departureAt, now),
      };
    }

    return {
      outcome: "cancelled",
      flight: cancelledView,
      remainingBookings: await remaining(),
    };
  };
}
