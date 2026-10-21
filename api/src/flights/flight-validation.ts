import type {
  CreateFlightInput,
  FlightFares,
  ValidationIssue,
  ValidationResult,
} from "../types.js";
import { normalizeRegistration } from "../aircraft/aircraft-validation.js";
import { type FareClass, isFareClass } from "../aircraft/seat-layout.js";
import { normalizeAirportCode } from "../airports/airport-validation.js";
import { isVndAmount, type Money, vnd } from "../money/money.js";
import { isNonEmptyString, isPlainObject } from "../validation.js";

/** Day 49A: one price per fare class replaced these (Decision 13). */
const REPLACED_BY_FARES = ["priceInCents", "currency"] as const;

const ISO_DATETIME_WITH_TZ =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isAirportCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/**
 * `{ "ECONOMY": 1500000, "BUSINESS": 4200000 }` — whole đồng per fare class
 * (BR-MONEY-01: VND only, so the request carries no currency). Every bad
 * entry is reported, not just the first.
 */
function parseFares(
  raw: unknown,
  issues: ValidationIssue[],
): FlightFares | undefined {
  if (!isPlainObject(raw)) {
    issues.push({
      field: "fares",
      code: "INVALID_FARES",
      message: "fares must be an object of fare class to amount in VND",
    });
    return undefined;
  }

  const issueCountBefore = issues.length;
  const fares: Partial<Record<FareClass, Money>> = {};

  for (const [fareClass, amount] of Object.entries(raw)) {
    if (!isFareClass(fareClass)) {
      issues.push({
        field: `fares.${fareClass}`,
        code: "INVALID_FARE_CLASS",
        message: "Fare class must be ECONOMY or BUSINESS",
      });
      continue;
    }

    if (!isVndAmount(amount) || amount === 0) {
      issues.push({
        field: `fares.${fareClass}`,
        code: "INVALID_FARE",
        message: `fares.${fareClass} must be a whole number of VND greater than 0`,
      });
      continue;
    }

    fares[fareClass] = vnd(amount);
  }

  return issues.length === issueCountBefore ? fares : undefined;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

function tryParseUtcIso(value: string): string | null {
  const match = ISO_DATETIME_WITH_TZ.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

export function validateCreateFlightInput(
  input: unknown,
): ValidationResult<CreateFlightInput> {
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

  const requiredFields = [
    "flightNumber",
    "origin",
    "destination",
    "aircraftRegistration",
    "departureAt",
    "arrivalAt",
    "fares",
  ] as const;

  for (const field of requiredFields) {
    if (!(field in input) || input[field] === undefined) {
      issues.push({
        field,
        code: "MISSING_FIELD",
        message: `${field} is required`,
      });
    }
  }

  // Day 46: capacity comes from the aircraft's layout. Rejected rather than
  // ignored, so a client still sending it learns the contract changed.
  if ("availableSeats" in input) {
    issues.push({
      field: "availableSeats",
      code: "UNSUPPORTED_FIELD",
      message:
        "availableSeats is no longer accepted: it is the aircraft's seat count",
    });
  }

  for (const field of REPLACED_BY_FARES) {
    if (field in input) {
      issues.push({
        field,
        code: "UNSUPPORTED_FIELD",
        message: `${field} is no longer accepted: send fares, one VND amount per fare class`,
      });
    }
  }

  const stringFields = [
    "flightNumber",
    "origin",
    "destination",
    "aircraftRegistration",
    "departureAt",
    "arrivalAt",
  ] as const;

  for (const field of stringFields) {
    if (!(field in input) || input[field] === undefined) {
      continue;
    }
    if (!isNonEmptyString(input[field])) {
      issues.push({
        field,
        code: "INVALID_STRING",
        message: `${field} must be a non-empty string`,
      });
    }
  }

  const flightNumberRaw = input.flightNumber;
  const originRaw = input.origin;
  const destinationRaw = input.destination;
  const departureRaw = input.departureAt;
  const arrivalRaw = input.arrivalAt;

  let flightNumber = "";
  let origin = "";
  let destination = "";
  let aircraftRegistration = "";
  let fares: FlightFares | undefined;
  let departureAtUtc: string | null = null;
  let arrivalAtUtc: string | null = null;

  if (isNonEmptyString(flightNumberRaw)) {
    flightNumber = flightNumberRaw.trim().toUpperCase();
  }

  if (isNonEmptyString(input.aircraftRegistration)) {
    aircraftRegistration = normalizeRegistration(input.aircraftRegistration);
  }

  if (isNonEmptyString(originRaw)) {
    origin = normalizeAirportCode(originRaw);
    if (!isAirportCode(origin)) {
      issues.push({
        field: "origin",
        code: "INVALID_AIRPORT_CODE",
        message: "Origin must be a three-letter airport code",
      });
    }
  }

  if (isNonEmptyString(destinationRaw)) {
    destination = normalizeAirportCode(destinationRaw);
    if (!isAirportCode(destination)) {
      issues.push({
        field: "destination",
        code: "INVALID_AIRPORT_CODE",
        message: "Destination must be a three-letter airport code",
      });
    }
  }

  if (
    isNonEmptyString(originRaw) &&
    isNonEmptyString(destinationRaw) &&
    isAirportCode(origin) &&
    isAirportCode(destination) &&
    origin === destination
  ) {
    issues.push({
      field: "destination",
      code: "ORIGIN_EQUALS_DESTINATION",
      message: "Origin and destination must be different",
    });
  }

  if ("fares" in input && input.fares !== undefined) {
    fares = parseFares(input.fares, issues);
  }

  if (isNonEmptyString(departureRaw)) {
    departureAtUtc = tryParseUtcIso(departureRaw.trim());
    if (!departureAtUtc) {
      issues.push({
        field: "departureAt",
        code: "INVALID_DATETIME",
        message: "departureAt must be ISO-8601 with timezone (Z or ±HH:MM)",
      });
    }
  }

  if (isNonEmptyString(arrivalRaw)) {
    arrivalAtUtc = tryParseUtcIso(arrivalRaw.trim());
    if (!arrivalAtUtc) {
      issues.push({
        field: "arrivalAt",
        code: "INVALID_DATETIME",
        message: "arrivalAt must be ISO-8601 with timezone (Z or ±HH:MM)",
      });
    }
  }

  if (departureAtUtc && arrivalAtUtc) {
    if (
      new Date(arrivalAtUtc).getTime() <= new Date(departureAtUtc).getTime()
    ) {
      issues.push({
        field: "arrivalAt",
        code: "ARRIVAL_BEFORE_DEPARTURE",
        message: "arrivalAt must be after departureAt",
      });
    }
  }

  if (issues.length > 0 || fares === undefined) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: {
      flightNumber,
      origin,
      destination,
      aircraftRegistration,
      departureAt: departureAtUtc as string,
      arrivalAt: arrivalAtUtc as string,
      fares,
    },
  };
}
