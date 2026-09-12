export type ValidationIssue = {
  field: string;
  code: string;
  message: string;
};

export type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; issues: ValidationIssue[] };

export type RegisterInput = {
  email: string;
  password: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRegisterInput(
  input: unknown,
): ValidationResult<RegisterInput> {
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

  if (typeof input.password !== "string") {
    issues.push({
      field: "password",
      code: "REQUIRED",
      message: "password must be a string",
    });
  } else if (input.password.length < MIN_PASSWORD_LENGTH) {
    issues.push({
      field: "password",
      code: "TOO_SHORT",
      message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
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
