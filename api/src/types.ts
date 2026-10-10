import type { StoredFlightStatus } from "./flights/flight-lifecycle.js";

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
  priceInCents: number;
  currency: string;
  /** Initialized from the aircraft's seat count; becomes derived in step 4. */
  availableSeats: number;
  status: StoredFlightStatus;
};

/**
 * Trusted create payload after validation — not derived from stored Flight.
 * Airports by IATA code and the aircraft by registration (both normalized);
 * the use case resolves them to ids. No availableSeats: it comes from the
 * aircraft's layout.
 */
export type CreateFlightInput = {
  flightNumber: string;
  origin: string;
  destination: string;
  aircraftRegistration: string;
  departureAt: string;
  arrivalAt: string;
  priceInCents: number;
  currency: string;
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
