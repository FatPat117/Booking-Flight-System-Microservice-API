import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { Flight, ValidationIssue } from "../types.js";
import type { FlightRepository } from "./flight-repository.js";
import { validateCreateFlightInput } from "./flight-validation.js";

export type CreateFlightResult =
  | { outcome: "created"; flight: Flight }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "duplicate" };

export type CreateFlight = (input: unknown) => CreateFlightResult;

type CreateFlightDependencies = {
  flightRepository: FlightRepository;
  auditRecorder: AuditRecorder;
  transactionRunner: TransactionRunner;
  generateId: () => string;
  generateAuditId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * Application use case: create a flight from untrusted input.
 * No Express, HTTP status, or SQLite knowledge.
 */
export function createCreateFlight(
  dependencies: CreateFlightDependencies,
): CreateFlight {
  const {
    flightRepository,
    auditRecorder,
    transactionRunner,
    generateId,
    generateAuditId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return (input: unknown): CreateFlightResult => {
    const validation = validateCreateFlightInput(input);

    if (!validation.success) {
      return {
        outcome: "validation_failed",
        issues: validation.issues,
      };
    }

    const validated = validation.value;

    const flight: Flight = {
      id: generateId(),
      flightNumber: validated.flightNumber,
      origin: validated.origin,
      destination: validated.destination,
      departureAt: validated.departureAt,
      arrivalAt: validated.arrivalAt,
      priceInCents: validated.priceInCents,
      currency: validated.currency,
      availableSeats: validated.availableSeats,
    };

    return transactionRunner.run(() => {
      const persistResult = flightRepository.create(flight);

      if (persistResult.outcome === "duplicate") {
        return { outcome: "duplicate" };
      }

      const requestId = getRequestId();

      auditRecorder.record({
        id: generateAuditId(),
        action: "FLIGHT_CREATED",
        actor: {
          type: "admin_api_key",
          id: "admin",
        },
        target: {
          type: "flight",
          id: flight.id,
        },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt: getCurrentTime().toISOString(),
        metadata: {
          flightNumber: flight.flightNumber,
          origin: flight.origin,
          destination: flight.destination,
        },
      });

      return { outcome: "created", flight };
    });
  };
}
