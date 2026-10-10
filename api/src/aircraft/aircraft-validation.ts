import type { ValidationIssue, ValidationResult } from "../types.js";
import { isNonEmptyString, isPlainObject } from "../validation.js";
import { expandSeatLayout, type LayoutSeat } from "./seat-layout.js";

export type RegisterAircraftInput = {
  registration: string;
  model: string;
  seats: LayoutSeat[];
};

/** Nationality prefix, optional hyphen, mark: `VN-A321`, `N12345`. */
const REGISTRATION = /^[A-Z0-9]{1,2}-?[A-Z0-9]{1,5}$/;
const MAX_MODEL_LENGTH = 50;

/** The one place a registration is normalized (BR-REF-02). */
export function normalizeRegistration(raw: string): string {
  return raw.trim().toUpperCase();
}

export function validateRegisterAircraftInput(
  input: unknown,
): ValidationResult<RegisterAircraftInput> {
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

  const issues: ValidationIssue[] = [];
  let registration = "";
  let model = "";

  if (!isNonEmptyString(input.registration)) {
    issues.push({
      field: "registration",
      code: "INVALID_STRING",
      message: "registration must be a non-empty string",
    });
  } else {
    registration = normalizeRegistration(input.registration);

    if (!REGISTRATION.test(registration)) {
      issues.push({
        field: "registration",
        code: "INVALID_REGISTRATION",
        message:
          "registration must be letters and digits with an optional hyphen, e.g. VN-A321",
      });
    }
  }

  if (!isNonEmptyString(input.model)) {
    issues.push({
      field: "model",
      code: "INVALID_STRING",
      message: "model must be a non-empty string",
    });
  } else if (input.model.trim().length > MAX_MODEL_LENGTH) {
    issues.push({
      field: "model",
      code: "TOO_LONG",
      message: `model must be at most ${MAX_MODEL_LENGTH} characters`,
    });
  } else {
    model = input.model.trim();
  }

  const layout = expandSeatLayout(input.seatLayout);

  if (!layout.success) {
    issues.push(...layout.issues);
  }

  if (issues.length > 0 || !layout.success) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: { registration, model, seats: layout.value },
  };
}
