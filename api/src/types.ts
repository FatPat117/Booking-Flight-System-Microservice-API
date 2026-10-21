import type { FareClass } from "./aircraft/seat-layout.js";
import type { StoredFlightStatus } from "./flights/flight-lifecycle.js";
import type { Money } from "./money/money.js";

/**
 * A flight's price per fare class (Decision 13). Exactly the classes its
 * aircraft has seats in (BR-FLT-09) — CreateFlight keeps that, so readers
 * may treat a missing class as "no such cabin", never "free".
 */
export type FlightFares = Readonly<Partial<Record<FareClass, Money>>>;

/**
 * Since Day 46 a flight references airports and an aircraft by id
 * (domain-model Decision 6). `origin`/`destination` keep the IATA codes:
 * the API and FlightCreatedEvent have always exposed them, and readers get
 * them from a join with `airports`, never from a stored copy.
 *
 * `status` is the *stored* status; the effective one (CLOSED, DEPARTED) is
 * derived from the clock by effectiveFlightStatus (ADR-008).
 */
export type Flight = {
  id: string;
  flightNumber: string;
  originAirportId: string;
  origin: string;
  destinationAirportId: string;
  destination: string;
  aircraftId: string;
  departureAt: string;
  arrivalAt: string;
  fares: FlightFares;
  /** Derived: the flight's AVAILABLE seats, counted on read (Day 47). */
  availableSeats: number;
  status: StoredFlightStatus;
};

/**
 * Trusted create payload after validation — not derived from stored Flight.
 * Airports by IATA code and the aircraft by registration (both normalized);
 * the use case resolves them to ids. No availableSeats: it comes from the
 * aircraft's layout. `fares` is well-formed here; whether its classes match
 * the aircraft's (BR-FLT-09) is the use case's check, once the aircraft is
 * known.
 */
export type CreateFlightInput = {
  flightNumber: string;
  origin: string;
  destination: string;
  aircraftRegistration: string;
  departureAt: string;
  arrivalAt: string;
  fares: FlightFares;
};

/**
 * The authenticated account performing a use case. Built by the route from
 * the verified JWT and passed in explicitly — use cases never read the
 * request context themselves, so they also run from jobs and consumers.
 */
export type Actor = Readonly<{
  accountId: string;
}>;

/**
 * Ids in this service are UUIDs (Postgres `uuid` columns). A string that is
 * not one cannot identify anything, so callers treat it as not-found rather
 * than sending it to Postgres (which rejects it with 22P02 → 500).
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export type ValidationIssue = {
  field: string;
  code: string;
  message: string;
};

export type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; issues: ValidationIssue[] };

export type ApiErrorDescriptor = {
  code: string;
  message: string;
  details?: ValidationIssue[];
};

export type ApiErrorResponse = {
  error: ApiErrorDescriptor;
};
