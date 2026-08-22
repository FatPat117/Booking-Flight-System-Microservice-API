/**
 * Wire contract for flight.created — copied from api (Day 22).
 * Must stay in sync manually until a shared contract package exists.
 */
export type FlightCreatedEvent = {
  eventId: string;
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

export function parseFlightCreatedEvent(
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

  if (typeof record.eventId !== "string" || record.eventId.length === 0) {
    return { ok: false, reason: "eventId must be a non-empty string" };
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
      eventId: record.eventId,
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
