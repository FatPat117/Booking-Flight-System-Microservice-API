import type { FlightCreatedEvent } from "@booking-flight-system/contracts";
import type { AircraftRepository } from "../aircraft/aircraft-repository.js";
import type { AirportRepository } from "../airports/airport-repository.js";
import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { Actor, Flight, ValidationIssue } from "../types.js";
import type { FlightRepository } from "./flight-repository.js";
import { validateCreateFlightInput } from "./flight-validation.js";
import { toFlightView, type FlightView } from "./flight-view.js";

export const FLIGHT_CREATED_QUEUE = "flight-created";

export type CreateFlightResult =
  | { outcome: "created"; flight: FlightView }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "duplicate" }
  | { outcome: "aircraft-unavailable" };

export type CreateFlight = (
  input: unknown,
  actor: Actor,
) => Promise<CreateFlightResult>;

type CreateFlightDependencies = {
  flightRepository: FlightRepository;
  airportRepository: AirportRepository;
  aircraftRepository: AircraftRepository;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  generateId: () => string;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

function unknownAirport(
  field: "origin" | "destination",
  code: string,
): ValidationIssue {
  return {
    field,
    code: "UNKNOWN_AIRPORT",
    message: `No airport is registered with code ${code}`,
  };
}

/**
 * Field by field, not `flight` its
 * and spreading the domain type woelf: the event is a published contract,uld publish every field Flight gains
 * (Day 46 leaked four that way until this mapping existed).
 */
function toFlightCreatedPayload(flight: Flight): FlightCreatedEvent["flight"] {
  return {
    id: flight.id,
    flightNumber: flight.flightNumber,
    origin: flight.origin,
    destination: flight.destination,
    departureAt: flight.departureAt,
    arrivalAt: flight.arrivalAt,
    priceInCents: flight.priceInCents,
    currency: flight.currency,
    availableSeats: flight.availableSeats,
    originAirportId: flight.originAirportId,
    destinationAirportId: flight.destinationAirportId,
    aircraftId: flight.aircraftId,
    status: flight.status,
  };
}

/**
 * Application use case: create a flight from untrusted input.
 * No Express, HTTP status, or database knowledge.
 *
 * Enqueues a `flight-created` outbox row inside the same transaction
 * as flight + audit — OutboxRelay publishes to RabbitMQ asynchronously.
 *
 * Day 46 (US-FLT-01): airports and aircraft are real references, resolved
 * from code / registration. The flight starts SCHEDULED with as many seats
 * as its aircraft has. Whether the aircraft is free (BR-FLT-03/08) is not
 * checked here — the database's exclusion constraint decides, so two admins
 * racing for the same aircraft cannot both win.
 */
export function createCreateFlight(
  dependencies: CreateFlightDependencies,
): CreateFlight {
  const {
    flightRepository,
    airportRepository,
    aircraftRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId,
    generateAuditId,
    generateOutboxId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (input: unknown, actor: Actor): Promise<CreateFlightResult> => {
    const validation = validateCreateFlightInput(input);

    if (!validation.success) {
      return {
        outcome: "validation_failed",
        issues: validation.issues,
      };
    }

    const validated = validation.value;

    const [origin, destination, aircraft] = await Promise.all([
      airportRepository.findByCode(validated.origin),
      airportRepository.findByCode(validated.destination),
      aircraftRepository.findByRegistration(validated.aircraftRegistration),
    ]);

    // Every unknown reference at once, like the field checks above.
    const unknown: ValidationIssue[] = [];
    if (origin === undefined) {
      unknown.push(unknownAirport("origin", validated.origin));
    }
    if (destination === undefined) {
      unknown.push(unknownAirport("destination", validated.destination));
    }
    if (aircraft === undefined) {
      unknown.push({
        field: "aircraftRegistration",
        code: "UNKNOWN_AIRCRAFT",
        message: `No aircraft is registered as ${validated.aircraftRegistration}`,
      });
    }

    if (
      origin === undefined ||
      destination === undefined ||
      aircraft === undefined
    ) {
      return { outcome: "validation_failed", issues: unknown };
    }

    const flight: Flight = {
      id: generateId(),
      flightNumber: validated.flightNumber,
      originAirportId: origin.id,
      origin: origin.code,
      destinationAirportId: destination.id,
      destination: destination.code,
      aircraftId: aircraft.id,
      departureAt: validated.departureAt,
      arrivalAt: validated.arrivalAt,
      priceInCents: validated.priceInCents,
      currency: validated.currency,
      availableSeats: aircraft.seats.length,
      status: "SCHEDULED",
    };

    return transactionRunner.run(async () => {
      const persistResult = await flightRepository.create(flight);

      if (
        persistResult.outcome === "duplicate" ||
        persistResult.outcome === "aircraft-unavailable"
      ) {
        return persistResult;
      }

      if (persistResult.outcome === "reference-not-found") {
        return {
          outcome: "validation_failed",
          issues: [
            {
              field: "body",
              code: "UNKNOWN_REFERENCE",
              message: "An airport or the aircraft no longer exists",
            },
          ],
        } as const;
      }

      const requestId = getRequestId();
      const now = getCurrentTime();
      const occurredAt = now.toISOString();
      const eventId = generateOutboxId();
      const correlationId = resolveCorrelationId(requestId, eventId);

      await auditRecorder.record({
        id: generateAuditId(),
        action: "FLIGHT_CREATED",
        actor: {
          type: "account",
          id: actor.accountId,
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
          aircraftRegistration: aircraft.registration,
          correlationId,
        },
      });

      const payload: FlightCreatedEvent = {
        eventId,
        correlationId,
        type: "flight.created",
        occurredAt,
        flight: toFlightCreatedPayload(flight),
      };

      await outboxRepository.enqueue({
        id: eventId,
        eventType: FLIGHT_CREATED_QUEUE,
        payload,
        createdAt: occurredAt,
      });

      return {
        outcome: "created",
        flight: toFlightView(flight, now),
      } as const;
    });
  };
}
