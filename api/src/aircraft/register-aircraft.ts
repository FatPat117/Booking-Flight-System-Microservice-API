import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { Actor, ValidationIssue } from "../types.js";
import type { Aircraft, AircraftRepository } from "./aircraft-repository.js";
import { validateRegisterAircraftInput } from "./aircraft-validation.js";
import { countSeatsByFareClass } from "./seat-layout.js";

export type RegisterAircraftResult =
  | { outcome: "created"; aircraft: Aircraft }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "duplicate" };

export type RegisterAircraft = (
  input: unknown,
  actor: Actor,
) => Promise<RegisterAircraftResult>;

type RegisterAircraftDependencies = {
  aircraftRepository: AircraftRepository;
  auditRecorder: AuditRecorder;
  transactionRunner: TransactionRunner;
  generateId: () => string;
  generateAuditId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * US-REF-02: the aircraft, its expanded seat layout and the audit row are
 * written in one transaction. No event (Day 27 rule: no consumer yet).
 */
export function createRegisterAircraft(
  dependencies: RegisterAircraftDependencies,
): RegisterAircraft {
  const {
    aircraftRepository,
    auditRecorder,
    transactionRunner,
    generateId,
    generateAuditId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (input, actor) => {
    const validation = validateRegisterAircraftInput(input);

    if (!validation.success) {
      return { outcome: "validation_failed", issues: validation.issues };
    }

    const occurredAt = getCurrentTime().toISOString();
    const aircraft: Aircraft = {
      id: generateId(),
      ...validation.value,
      createdAt: occurredAt,
    };

    return transactionRunner.run(async () => {
      const result = await aircraftRepository.create(aircraft);

      if (result.outcome === "duplicate") {
        return { outcome: "duplicate" } as const;
      }

      const requestId = getRequestId();
      const seats = countSeatsByFareClass(aircraft.seats);

      await auditRecorder.record({
        id: generateAuditId(),
        action: "AIRCRAFT_REGISTERED",
        actor: { type: "account", id: actor.accountId },
        target: { type: "aircraft", id: aircraft.id },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt,
        metadata: {
          registration: aircraft.registration,
          economySeats: seats.ECONOMY,
          businessSeats: seats.BUSINESS,
        },
      });

      return { outcome: "created", aircraft } as const;
    });
  };
}
