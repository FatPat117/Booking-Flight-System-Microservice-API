import type { ValidationIssue, ValidationResult } from "../types.js";
import type { FlightSearchQuery, FlightSearchSort } from "./flight-search.js";

export type RawFlightSearchQuery = {
  origin?: unknown;
  destination?: unknown;
  departureDateFrom?: unknown;
  departureDateTo?: unknown;
  passengers?: unknown;
  sort?: unknown;
  limit?: unknown;
  cursor?: unknown;
};

export type ValidFlightSearchInput = Readonly<{
  query: Omit<FlightSearchQuery, "after">;
  cursor: string | undefined;
}>;

/** Decision 17: at most 7 local dates, 1–9 passengers (BR-BOOK-01), pages of 1–50. */
export const MAX_SEARCH_DAYS = 7;
export const MAX_SEARCH_PASSENGERS = 9;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

const AIRPORT_CODE = /^[A-Z]{3}$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSITIVE_INTEGER = /^\d{1,3}$/;
const SORTS: readonly FlightSearchSort[] = ["departure", "price"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** A calendar date that exists (`2026-02-30` does not), as days since the epoch. */
function parseLocalDate(value: string): number | undefined {
  const match = LOCAL_DATE.exec(value);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const instant = Date.UTC(year, month - 1, day);
  const back = new Date(instant);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return undefined;
  }
  return instant / DAY_MS;
}

function parseBoundedInteger(raw: unknown, fallback: number, max: number): number | undefined {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !POSITIVE_INTEGER.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return value >= 1 && value <= max ? value : undefined;
}

/**
 * Query string → search (Decision 17). Every problem is reported at once,
 * like the other validators. Query values arrive as strings, or as arrays
 * when a parameter is repeated — an array is invalid, never "the first one".
 */
export function validateFlightSearchQuery(raw: RawFlightSearchQuery): ValidationResult<ValidFlightSearchInput> {
  const issues: ValidationIssue[] = [];

  const code = (field: "origin" | "destination"): string | undefined => {
    const value = raw[field];
    if (value === undefined || value === "") {
      issues.push({ field, code: "MISSING_FIELD", message: `${field} is required` });
      return undefined;
    }
    const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!AIRPORT_CODE.test(normalized)) {
      issues.push({ field, code: "INVALID_AIRPORT_CODE", message: `${field} must be a three-letter airport code` });
      return undefined;
    }
    return normalized;
  };
  const origin = code("origin");
  const destination = code("destination");
  if (origin !== undefined && origin === destination) {
    issues.push({ field: "destination", code: "ORIGIN_EQUALS_DESTINATION", message: "Origin and destination must be different" });
  }

  const date = (field: "departureDateFrom" | "departureDateTo"): [string, number] | undefined => {
    const value = raw[field];
    const days = typeof value === "string" ? parseLocalDate(value) : undefined;
    if (typeof value !== "string" || days === undefined) {
      issues.push({ field, code: "INVALID_DATE", message: `${field} must be a calendar date (YYYY-MM-DD)` });
      return undefined;
    }
    return [value, days];
  };
  let from: [string, number] | undefined;
  if (raw.departureDateFrom === undefined || raw.departureDateFrom === "") {
    issues.push({ field: "departureDateFrom", code: "MISSING_FIELD", message: "departureDateFrom is required" });
  } else {
    from = date("departureDateFrom");
  }
  const to = raw.departureDateTo === undefined ? from : date("departureDateTo");
  if (from !== undefined && to !== undefined) {
    if (to[1] < from[1]) {
      issues.push({ field: "departureDateTo", code: "INVALID_DATE_RANGE", message: "departureDateTo must not be before departureDateFrom" });
    } else if (to[1] - from[1] + 1 > MAX_SEARCH_DAYS) {
      issues.push({ field: "departureDateTo", code: "DATE_RANGE_TOO_LONG", message: `A search covers at most ${MAX_SEARCH_DAYS} days` });
    }
  }

  const passengers = parseBoundedInteger(raw.passengers, 1, MAX_SEARCH_PASSENGERS);
  if (passengers === undefined) {
    issues.push({ field: "passengers", code: "INVALID_PASSENGER_COUNT", message: `passengers must be an integer from 1 to ${MAX_SEARCH_PASSENGERS}` });
  }

  const sort = raw.sort === undefined ? "departure" : SORTS.find((candidate) => candidate === raw.sort);
  if (sort === undefined) {
    issues.push({ field: "sort", code: "INVALID_SORT", message: "sort must be departure or price" });
  }

  const limit = parseBoundedInteger(raw.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  if (limit === undefined) {
    issues.push({ field: "limit", code: "INVALID_LIMIT", message: `limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}` });
  }

  if (raw.cursor !== undefined && typeof raw.cursor !== "string") {
    issues.push({ field: "cursor", code: "INVALID_CURSOR", message: "cursor must be a single value" });
  }

  if (
    issues.length > 0 ||
    origin === undefined ||
    destination === undefined ||
    from === undefined ||
    to === undefined ||
    passengers === undefined ||
    sort === undefined ||
    limit === undefined
  ) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: {
      query: {
        origin,
        destination,
        departureDateFrom: from[0],
        departureDateTo: to[0],
        passengers,
        sort,
        limit,
      },
      cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
    },
  };
}
