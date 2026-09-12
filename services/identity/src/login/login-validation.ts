import type { ValidationIssue, ValidationResult } from "../register/register-validation.js";

export type LoginInput = {
  email: string;
  password: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Login validation: non-empty email/password + email format.
 * Does not enforce password min length — that is a register-time rule.
 */
export function validateLoginInput(
  input: unknown,
): ValidationResult<LoginInput> {
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

  if (typeof input.email !== "string" || input.email.trim() === "") {
    issues.push({
      field: "email",
      code: "REQUIRED",
      message: "email must be a non-empty string",
    });
  } else if (!EMAIL_PATTERN.test(input.email.trim())) {
    issues.push({
      field: "email",
      code: "INVALID_FORMAT",
      message: "email must be a valid email address",
    });
  }

  if (typeof input.password !== "string" || input.password.length === 0) {
    issues.push({
      field: "password",
      code: "REQUIRED",
      message: "password must be a non-empty string",
    });
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: {
      email: (input.email as string).trim().toLowerCase(),
      password: input.password as string,
    },
  };
}
