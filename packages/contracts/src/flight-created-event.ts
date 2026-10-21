/**
 * Evolves additively (expand/contract for messages). Day 46 added the
 * references and the status; the producer always sends them, but they are
 * optional here because messages written before Day 46 may still sit in the
 * outbox, the queue or the DLQ. Making them required — and ever dropping
 * `origin`/`destination` — is a later contract step, once no old-shape
 * message and no consumer relying on the old fields remains.
 *
 * Day 49A added `fares`, one price per fare class. `priceInCents` and
 * `currency` are deprecated: still sent (the ECONOMY fare in whole VND, and
 * "VND") so existing consumers keep working, to be dropped in a contract
 * step once none reads them.
 */
export type FlightCreatedFare = {
  /** Integer in the currency's smallest unit — whole đồng for VND. */
  amount: number;
  currency: string;
};

export type FlightCreatedEvent = {
  eventId: string;
  correlationId: string;
  type: "flight.created";
  occurredAt: string;
  flight: {
    id: string;
    flightNumber: string;
    /** IATA code. */
    origin: string;
    /** IATA code. */
    destination: string;
    departureAt: string;
    arrivalAt: string;
    /** @deprecated Day 49A — read `fares`. Despite the name, whole đồng. */
    priceInCents: number;
    /** @deprecated Day 49A — always "VND"; read `fares`. */
    currency: string;
    /** Keyed by fare class (ECONOMY, BUSINESS); absent before Day 49A. */
    fares?: Record<string, FlightCreatedFare>;
    availableSeats: number;
    originAirportId?: string;
    destinationAirportId?: string;
    aircraftId?: string;
    /** Status at creation (SCHEDULED); later changes have no event yet. */
    status?: string;
  };
};

const OPTIONAL_FLIGHT_STRINGS = [
  "originAirportId",
  "destinationAirportId",
  "aircraftId",
  "status",
] as const;

function parseFares(
  value: unknown,
): { ok: true; fares: Record<string, FlightCreatedFare> } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "flight.fares must be an object when present" };
  }

  const fares: Record<string, FlightCreatedFare> = {};

  for (const [fareClass, fare] of Object.entries(value)) {
    const record = fare as Record<string, unknown> | null;
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.amount !== "number" ||
      !Number.isSafeInteger(record.amount) ||
      record.amount <= 0 ||
      typeof record.currency !== "string" ||
      record.currency.length === 0
    ) {
      return {
        ok: false,
        reason: `flight.fares.${fareClass} must have a positive integer amount and a currency`,
      };
    }
    fares[fareClass] = { amount: record.amount, currency: record.currency };
  }

  return { ok: true, fares };
}

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

  if (
    typeof record.correlationId !== "string" ||
    record.correlationId.length === 0
  ) {
    return { ok: false, reason: "correlationId must be a non-empty string" };
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

  // Absent is the old shape and fine; present but empty is a broken producer.
  const optional: Partial<
    Record<(typeof OPTIONAL_FLIGHT_STRINGS)[number], string>
  > = {};
  for (const key of OPTIONAL_FLIGHT_STRINGS) {
    const value = flight[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        reason: `flight.${key} must be a non-empty string when present`,
      };
    }
    optional[key] = value;
  }

  let fares: Record<string, FlightCreatedFare> | undefined;
  if (flight.fares !== undefined) {
    const parsedFares = parseFares(flight.fares);
    if (!parsedFares.ok) {
      return parsedFares;
    }
    fares = parsedFares.fares;
  }

  return {
    ok: true,
    event: {
      eventId: record.eventId,
      correlationId: record.correlationId,
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
        ...optional,
        ...(fares === undefined ? {} : { fares }),
      },
    },
  };
}
