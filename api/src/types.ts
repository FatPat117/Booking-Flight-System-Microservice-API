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
