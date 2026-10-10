import type { ValidationIssue, ValidationResult } from "../types.js";
import { isNonEmptyString, isPlainObject } from "../validation.js";

export type RegisterAirportInput = {
  code: string;
  name: string;
  city: string;
  timeZone: string;
};

const AIRPORT_CODE = /^[A-Z]{3}$/;
const MAX_TEXT_LENGTH = 100;

/**
 * `Area/Location` names (`Asia/Ho_Chi_Minh`, `America/Argentina/Buenos_Aires`,
 * `Etc/GMT+7`) or `UTC`. Excludes what Intl would also accept but is not a
 * time zone a person means: offsets (`+07:00`) and legacy abbreviations
 * (`EST` silently resolves to `America/Panama`). Each segment starts upper
 * case so `asia/ho_chi_minh` is not stored in a second spelling.
 */
const IANA_NAME = /^(UTC|[A-Z][A-Za-z_]*(\/[A-Z][A-Za-z0-9_+-]*)+)$/;

/** The one place an airport code is normalized (BR-REF-01). */
export function normalizeAirportCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * BR-REF-04, checked on write only. Deliberately not
 * `Intl.supportedValuesOf("timeZone")`: that list holds canonical names
 * only, and this Node's ICU lists `Asia/Saigon` but not `Asia/Ho_Chi_Minh`.
 * Asking the formatter accepts every IANA name and alias. The value is
 * stored as given, not as `resolvedOptions().timeZone`, which would
 * silently rewrite `Asia/Ho_Chi_Minh` to `Asia/Saigon`.
 */
export function isIanaTimeZone(value: string): boolean {
  if (!IANA_NAME.test(value)) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validateRegisterAirportInput(
  input: unknown,
): ValidationResult<RegisterAirportInput> {
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
  const text: Record<"code" | "name" | "city" | "timeZone", string> = {
    code: "",
    name: "",
    city: "",
    timeZone: "",
  };

  for (const field of ["code", "name", "city", "timeZone"] as const) {
    const raw = input[field];

    if (!isNonEmptyString(raw)) {
      issues.push({
        field,
        code: "INVALID_STRING",
        message: `${field} must be a non-empty string`,
      });
      continue;
    }

    if (raw.trim().length > MAX_TEXT_LENGTH) {
      issues.push({
        field,
        code: "TOO_LONG",
        message: `${field} must be at most ${MAX_TEXT_LENGTH} characters`,
      });
      continue;
    }

    text[field] = raw.trim();
  }

  const code = normalizeAirportCode(text.code);

  if (text.code !== "" && !AIRPORT_CODE.test(code)) {
    issues.push({
      field: "code",
      code: "INVALID_AIRPORT_CODE",
      message: "code must be exactly 3 letters",
    });
  }

  if (text.timeZone !== "" && !isIanaTimeZone(text.timeZone)) {
    issues.push({
      field: "timeZone",
      code: "INVALID_TIME_ZONE",
      message:
        "timeZone must be an IANA time zone name such as Asia/Ho_Chi_Minh, not an offset",
    });
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: {
      code,
      name: text.name,
      city: text.city,
      timeZone: text.timeZone,
    },
  };
}
