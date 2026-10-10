import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { Actor, ValidationIssue } from "../types.js";
import type { Airport, AirportRepository } from "./airport-repository.js";
import { validateRegisterAirportInput } from "./airport-validation.js";

export type RegisterAirportResult =
  | { outcome: "created"; airport: Airport }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "duplicate" };

export type RegisterAirport = (
  input: unknown,
  actor: Actor,
) => Promise<RegisterAirportResult>;

type RegisterAirportDependencies = {
  airportRepository: AirportRepository;
  auditRecorder: AuditRecorder;
  transactionRunner: TransactionRunner;
  generateId: () => string;
  generateAuditId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * US-REF-01. No event: nothing consumes "airport registered" yet (Day 27
 * rule), so the audit row is the only side effect.
 */
export function createRegisterAirport(
  dependencies: RegisterAirportDependencies,
): RegisterAirport {
  const {
    airportRepository,
    auditRecorder,
    transactionRunner,
    generateId,
    generateAuditId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (input, actor) => {
    const validation = validateRegisterAirportInput(input);

    if (!validation.success) {
      return { outcome: "validation_failed", issues: validation.issues };
    }

    const occurredAt = getCurrentTime().toISOString();
    const airport: Airport = {
      id: generateId(),
      ...validation.value,
      createdAt: occurredAt,
    };

    return transactionRunner.run(async () => {
      const result = await airportRepository.create(airport);

      if (result.outcome === "duplicate") {
        return { outcome: "duplicate" } as const;
      }

      const requestId = getRequestId();

      await auditRecorder.record({
        id: generateAuditId(),
        action: "AIRPORT_REGISTERED",
        actor: { type: "account", id: actor.accountId },
        target: { type: "airport", id: airport.id },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt,
        metadata: { code: airport.code, timeZone: airport.timeZone },
      });

      return { outcome: "created", airport } as const;
    });
  };
}
