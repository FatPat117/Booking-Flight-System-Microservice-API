import type { ValidationIssue, ValidationResult } from "../types.js";

export type CreateBookingInput = {
  passengerName: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function validateCreateBookingInput(
  input: unknown,
): ValidationResult<CreateBookingInput> {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(input)) {
    return {
      success: false,
      issues: [
        {
          field: "body",
          code: "INVALID_BODY",
          message: "Request body must be a JSON object",
        },
      ],
    };
  }

  if (!isNonEmptyString(input.passengerName)) {
    issues.push({
      field: "passengerName",
      code: "REQUIRED",
      message: "passengerName must be a non-empty string",
    });
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: {
      passengerName: (input.passengerName as string).trim(),
    },
  };
}

export function validateFlightIdParam(
  flightId: unknown,
): ValidationResult<string> {
  if (typeof flightId !== "string" || flightId.trim() === "") {
    return {
      success: false,
      issues: [
        {
          field: "flightId",
          code: "REQUIRED",
          message: "flightId must be a non-empty string",
        },
      ],
    };
  }

  return {
    success: true,
    value: flightId.trim(),
  };
}

export function validateBookingIdParam(
  bookingId: unknown,
): ValidationResult<string> {
  if (typeof bookingId !== "string" || bookingId.trim() === "") {
    return {
      success: false,
      issues: [
        {
          field: "bookingId",
          code: "REQUIRED",
          message: "bookingId must be a non-empty string",
        },
      ],
    };
  }

  return {
    success: true,
    value: bookingId.trim(),
  };
}
