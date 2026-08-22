import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
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
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  generateId: () => string;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * Application use case: create a flight from untrusted input.
 * No Express, HTTP status, or SQLite knowledge.
 *
 * Enqueues a `flight-created` outbox row inside the same SQLite transaction
 * as flight + audit — OutboxRelay publishes to RabbitMQ asynchronously.
 */
export function createCreateFlight(
  dependencies: CreateFlightDependencies,
): CreateFlight {
  const {
    flightRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId,
    generateAuditId,
    generateOutboxId,
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

    return transactionRunner.run(() => {
      const persistResult = flightRepository.create(flight);

      if (persistResult.outcome === "duplicate") {
        return { outcome: "duplicate" } as const;
      }

      const requestId = getRequestId();
      const occurredAt = getCurrentTime().toISOString();

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
        occurredAt,
        metadata: {
          flightNumber: flight.flightNumber,
          origin: flight.origin,
          destination: flight.destination,
        },
      });

      const eventId = generateOutboxId();

      outboxRepository.enqueue({
        id: eventId,
        eventType: FLIGHT_CREATED_QUEUE,
        payload: {
          eventId,
          type: "flight.created",
          occurredAt,
          flight,
        },
        createdAt: occurredAt,
      });

      return { outcome: "created", flight } as const;
    });
  };
}
