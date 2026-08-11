import type { Logger } from "../observability/logger.js";
import type {
  MessageHandler,
  MessageHandlerResult,
} from "./message-consumer.js";

/**
 * Event-facing shape for flight.created — validated separately from domain Flight
 * so the wire format can evolve without coupling every consumer to the DB entity.
 */
export type FlightCreatedEvent = {
  type: "flight.created";
  occurredAt: string;
  flight: {
    id: string;
    flightNumber: string;
    origin: string;
    destination: string;
    departureAt: string;
    arrivalAt: string;
    priceInCents: number;
    currency: string;
    availableSeats: number;
  };
};

export function createFlightCreatedConsumer(deps: {
  logger: Logger;
}): MessageHandler {
  return async (payload: unknown): Promise<MessageHandlerResult> => {
    const parsed = parseFlightCreatedEvent(payload);

    if (!parsed.ok) {
      return { outcome: "rejected", reason: parsed.reason };
    }

    const { event } = parsed;

    deps.logger.info("flight_created_consumed", {
      flightId: event.flight.id,
      flightNumber: event.flight.flightNumber,
      origin: event.flight.origin,
      destination: event.flight.destination,
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}

function parseFlightCreatedEvent(
  payload: unknown,
):
  | { ok: true; event: FlightCreatedEvent }
  | { ok: false; reason: string } {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "payload must be an object" };
  }

  const record = payload as Record<string, unknown>;

  if (record.type !== "flight.created") {
    return { ok: false, reason: 'type must be "flight.created"' };
  }

  if (typeof record.occurredAt !== "string" || record.occurredAt.length === 0) {
    return { ok: false, reason: "occurredAt must be a non-empty string" };
  }

  if (record.flight === null || typeof record.flight !== "object") {
    return { ok: false, reason: "flight must be an object" };
  }

  const flight = record.flight as Record<string, unknown>;
  const requiredStrings = [
    "id",
    "flightNumber",
    "origin",
    "destination",
    "departureAt",
    "arrivalAt",
    "currency",
  ] as const;

  for (const key of requiredStrings) {
    if (typeof flight[key] !== "string" || flight[key].length === 0) {
      return {
        ok: false,
        reason: `flight.${key} must be a non-empty string`,
      };
    }
  }

  if (
    typeof flight.priceInCents !== "number" ||
    !Number.isInteger(flight.priceInCents)
  ) {
    return { ok: false, reason: "flight.priceInCents must be an integer" };
  }

  if (
    typeof flight.availableSeats !== "number" ||
    !Number.isInteger(flight.availableSeats)
  ) {
    return { ok: false, reason: "flight.availableSeats must be an integer" };
  }

  return {
    ok: true,
    event: {
      type: "flight.created",
      occurredAt: record.occurredAt,
      flight: {
        id: flight.id as string,
        flightNumber: flight.flightNumber as string,
        origin: flight.origin as string,
        destination: flight.destination as string,
        departureAt: flight.departureAt as string,
        arrivalAt: flight.arrivalAt as string,
        priceInCents: flight.priceInCents,
        currency: flight.currency as string,
        availableSeats: flight.availableSeats,
      },
    },
  };
}
