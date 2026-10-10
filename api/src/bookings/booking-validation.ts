import type { ValidationIssue, ValidationResult } from "../types.js";
import { isNonEmptyString, isPlainObject } from "../validation.js";

export type CreateBookingInput = {
  passengerName: string;
};

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
