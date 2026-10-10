/**
 * The Flight lifecycle (domain-model.md, "Lifecycles → Flight") as data plus
 * pure functions. The single place that decides which status changes are
 * legal; use cases ask, they do not re-implement the rules with `if`s.
 */

/** What a person sets and the database stores (CHK_flights_status). */
export const STORED_FLIGHT_STATUSES = ["SCHEDULED", "OPEN", "CANCELLED"] as const;
export type StoredFlightStatus = (typeof STORED_FLIGHT_STATUSES)[number];

/** Stored statuses plus the two derived from the clock (ADR-008). */
export const FLIGHT_STATUSES = [
  "SCHEDULED",
  "OPEN",
  "CLOSED",
  "DEPARTED",
  "CANCELLED",
] as const;
export type FlightStatus = (typeof FLIGHT_STATUSES)[number];

/** BR-FLT-06: sales close 1 hour before departure. */
export const SALES_CLOSE_BEFORE_DEPARTURE_MS = 60 * 60 * 1000;

/**
 * BR-FLT-08: minimum time on the ground between two flights of one aircraft.
 * Mirrors flight_aircraft_occupancy() in the AddAircraftScheduleExclusion
 * migration — the flight repository contract test keeps the two in step.
 */
export const AIRCRAFT_TURNAROUND_MS = 45 * 60 * 1000;

export function isStoredFlightStatus(
  value: string,
): value is StoredFlightStatus {
  return STORED_FLIGHT_STATUSES.some((status) => status === value);
}

/**
 * For adapters reading `flights.status`. CHK_flights_status makes any other
 * value impossible, so a mismatch means schema and code disagree — a bug to
 * surface, not a value to coerce.
 */
export function toStoredFlightStatus(value: string): StoredFlightStatus {
  if (!isStoredFlightStatus(value)) {
    throw new Error(`Unexpected flights.status value: ${value}`);
  }
  return value;
}

/**
 * Decision 9 / ADR-008: CLOSED and DEPARTED are never stored. Every rule,
 * read and transition uses this. The seat-hold UPDATE repeats the OPEN case
 * in SQL (`status = 'OPEN' AND departure_at - 1 hour > now`).
 */
export function effectiveFlightStatus(
  stored: StoredFlightStatus,
  departureAt: string,
  now: Date,
): FlightStatus {
  if (stored === "CANCELLED") {
    return "CANCELLED";
  }

  const departure = new Date(departureAt).getTime();
  const instant = now.getTime();

  if (instant >= departure) {
    return "DEPARTED";
  }

  if (
    stored === "OPEN" &&
    instant >= departure - SALES_CLOSE_BEFORE_DEPARTURE_MS
  ) {
    return "CLOSED";
  }

  return stored;
}

/** BR-FLT-06: a seat can be held only while the effective status is OPEN. */
export function isBookable(
  stored: StoredFlightStatus,
  departureAt: string,
  now: Date,
): boolean {
  return effectiveFlightStatus(stored, departureAt, now) === "OPEN";
}

export type TransitionRejection = "NOT_ALLOWED" | "DEPARTURE_TOO_SOON";

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: TransitionRejection };

export type TransitionContext = Readonly<{
  departureAt: string;
  now: Date;
}>;

/** A condition on one transition: undefined when it holds. */
type TransitionGuard = (
  context: TransitionContext,
) => TransitionRejection | undefined;

const unconditional: TransitionGuard = () => undefined;

/** SCHEDULED → OPEN: "departure more than 1 h away". */
const departsMoreThanAnHourAhead: TransitionGuard = ({ departureAt, now }) =>
  new Date(departureAt).getTime() - now.getTime() >
  SALES_CLOSE_BEFORE_DEPARTURE_MS
    ? undefined
    : "DEPARTURE_TOO_SOON";

/**
 * Keyed by *effective* status. Only stored statuses appear as targets: a
 * person can open or cancel a flight, never "close" or "depart" it. A pair
 * missing here is forbidden — so the terminal statuses have empty rows.
 *
 * → CANCELLED is legal here but not offered by any route until phase D step
 * 9 adds the booking cascade (domain-model, "Not yet reachable").
 */
const FLIGHT_TRANSITIONS: Readonly<
  Record<FlightStatus, Readonly<Partial<Record<FlightStatus, TransitionGuard>>>>
> = {
  SCHEDULED: { OPEN: departsMoreThanAnHourAhead, CANCELLED: unconditional },
  OPEN: { CANCELLED: unconditional },
  CLOSED: { CANCELLED: unconditional },
  DEPARTED: {},
  CANCELLED: {},
};

export function transitionFlight(
  from: FlightStatus,
  to: FlightStatus,
  context: TransitionContext,
): TransitionResult {
  const guard = FLIGHT_TRANSITIONS[from][to];

  if (guard === undefined) {
    return { ok: false, reason: "NOT_ALLOWED" };
  }

  const rejection = guard(context);

  return rejection === undefined
    ? { ok: true }
    : { ok: false, reason: rejection };
}
