import {
  formatSeatPosition,
  parseSeatPosition,
  type SeatPosition,
} from "../aircraft/seat-position.js";
import type { ValidationIssue, ValidationResult } from "../types.js";
import { isNonEmptyString, isPlainObject } from "../validation.js";

/** BR-BOOK-01. */
export const MAX_PASSENGERS = 9;

/**
 * BR-BOOK-09 as a type: every passenger names a seat, or none does — a mix
 * cannot be represented, so the use case never has to handle one.
 */
export type CreateBookingInput =
  | { seatSelection: "auto"; passengers: Array<{ name: string }> }
  | {
      seatSelection: "chosen";
      passengers: Array<{ name: string; seat: SeatPosition }>;
    };

type ParsedPassenger = { name: string; seat: SeatPosition | undefined };

function invalid(issues: ValidationIssue[]): ValidationResult<never> {
  return { success: false, issues };
}

function validatePassenger(
  value: unknown,
  field: string,
  issues: ValidationIssue[],
): ParsedPassenger | undefined {
  if (!isPlainObject(value)) {
    issues.push({
      field,
      code: "INVALID_PASSENGER",
      message: "each passenger must be an object { name, seat? }",
    });
    return undefined;
  }

  const issueCount = issues.length;

  if (!isNonEmptyString(value.name)) {
    issues.push({
      field: `${field}.name`,
      code: "REQUIRED",
      message: "name must be a non-empty string",
    });
  }

  // Absent means "pick for me"; anything present must be a seat code.
  const seat =
    typeof value.seat === "string" ? parseSeatPosition(value.seat) : undefined;
  if (value.seat !== undefined && seat === undefined) {
    issues.push({
      field: `${field}.seat`,
      code: "INVALID_SEAT",
      message: "seat must be a seat code such as 12A",
    });
  }

  if (issues.length > issueCount) {
    return undefined;
  }

  return { name: (value.name as string).trim(), seat };
}

export function validateCreateBookingInput(
  input: unknown,
): ValidationResult<CreateBookingInput> {
  if (!isPlainObject(input)) {
    return invalid([
      {
        field: "body",
        code: "INVALID_BODY",
        message: "Request body must be a JSON object",
      },
    ]);
  }

  const issues: ValidationIssue[] = [];

  // The Day 44 body. Rejected by name rather than ignored: a client still
  // sending it gets told what changed instead of a bare "passengers required".
  if (input.passengerName !== undefined) {
    issues.push({
      field: "passengerName",
      code: "UNSUPPORTED_FIELD",
      message: "passengerName was replaced by passengers: [{ name, seat? }]",
    });
  }

  const { passengers } = input;

  // The count is checked before any passenger is looked at, so an oversized
  // array costs one comparison (Decision 11, the Day 45 amplification lesson).
  if (
    !Array.isArray(passengers) ||
    passengers.length === 0 ||
    passengers.length > MAX_PASSENGERS
  ) {
    issues.push({
      field: "passengers",
      code: "INVALID_PASSENGER_COUNT",
      message: `passengers must be an array of 1 to ${MAX_PASSENGERS} passengers`,
    });
    return invalid(issues);
  }

  const parsed = passengers.map((passenger, index) =>
    validatePassenger(passenger, `passengers[${index}]`, issues),
  );

  if (issues.length > 0) {
    return invalid(issues);
  }

  const valid = parsed as ParsedPassenger[];
  const named = valid.filter((passenger) => passenger.seat !== undefined);

  if (named.length === 0) {
    return {
      success: true,
      value: {
        seatSelection: "auto",
        passengers: valid.map(({ name }) => ({ name })),
      },
    };
  }

  if (named.length < valid.length) {
    return invalid([
      {
        field: "passengers",
        code: "MIXED_SEAT_SELECTION",
        message: "either every passenger names a seat or none does",
      },
    ]);
  }

  // BR-BOOK-02: each later repeat is reported, the first use is not.
  const seen = new Set<string>();
  valid.forEach((passenger, index) => {
    const code = formatSeatPosition(passenger.seat as SeatPosition);
    if (seen.has(code)) {
      issues.push({
        field: `passengers[${index}].seat`,
        code: "DUPLICATE_SEAT",
        message: `seat ${code} is already taken by an earlier passenger`,
      });
    }
    seen.add(code);
  });

  if (issues.length > 0) {
    return invalid(issues);
  }

  return {
    success: true,
    value: {
      seatSelection: "chosen",
      passengers: valid.map(({ name, seat }) => ({
        name,
        seat: seat as SeatPosition,
      })),
    },
  };
}
