export type Flight = {
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

/** Trusted create payload after validation — not derived from stored Flight. */
export type CreateFlightInput = {
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  priceInCents: number;
  currency: string;
  availableSeats: number;
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
