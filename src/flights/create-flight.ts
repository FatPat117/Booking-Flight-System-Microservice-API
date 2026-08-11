import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { MessagePublisher } from "../messaging/message-publisher.js";
import type { Logger } from "../observability/logger.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { Flight, ValidationIssue } from "../types.js";
import type { FlightRepository } from "./flight-repository.js";
import { validateCreateFlightInput } from "./flight-validation.js";

export const FLIGHT_CREATED_QUEUE = "flight-created";

export type CreateFlightResult =
  | { outcome: "created"; flight: Flight }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "duplicate" };

export type CreateFlight = (input: unknown) => Promise<CreateFlightResult>;

type CreateFlightDependencies = {
  flightRepository: FlightRepository;
  auditRecorder: AuditRecorder;
  transactionRunner: TransactionRunner;
  messagePublisher: MessagePublisher;
  logger: Logger;
  generateId: () => string;
  generateAuditId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * Application use case: create a flight from untrusted input.
 * No Express, HTTP status, or SQLite knowledge.
 *
 * After a successful DB commit, publishes a fat `flight-created` event.
 * Publish failure is logged only — dual-write is accepted for Day 20 (no outbox yet).
 */
export function createCreateFlight(
  dependencies: CreateFlightDependencies,
): CreateFlight {
  const {
    flightRepository,
    auditRecorder,
    transactionRunner,
    messagePublisher,
    logger,
    generateId,
    generateAuditId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (input: unknown): Promise<CreateFlightResult> => {
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

    const result = transactionRunner.run(() => {
      const persistResult = flightRepository.create(flight);

      if (persistResult.outcome === "duplicate") {
        return { outcome: "duplicate" } as const;
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

      return { outcome: "created", flight } as const;
    });

    // Publish only after the SQLite transaction has committed successfully.
    if (result.outcome === "created") {
      try {
        await messagePublisher.publish(FLIGHT_CREATED_QUEUE, {
          type: "flight.created",
          occurredAt: getCurrentTime().toISOString(),
          // Fat event: consumer can act without calling back into this API.
          flight: result.flight,
        });
      } catch (error) {
        // Dual-write: flight is already durable; message may be lost.
        logger.error("flight_created_publish_failed", {
          flightId: result.flight.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  };
}
