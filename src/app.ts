import express from "express";

import {
  errorHandler,
  notFoundHandler,
  sendApiError,
} from "./http-errors.js";
import type {
  CreateFlightRequest,
  Flight,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

export function createApp() {
  const app = express();
  const flights: Flight[] = [];

  // Middleware — strict: false so valid JSON primitives reach the validator (422),
  // while malformed JSON still fails at the parser (400).
  app.use(express.json({ strict: false }));

  const SUPPORTED_CURRENCIES = new Set(["VND", "USD"]);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/flights", (_req, res) => {
    res.status(200).json(flights);
  });

  app.get("/api/flights/:id", (req, res) => {
    const { id } = req.params;
    const flight = flights.find((f) => f.id === id);

    if (!flight) {
      return sendApiError(res, 404, {
        code: "FLIGHT_NOT_FOUND",
        message: "Flight was not found",
      });
    }

    return res.status(200).json(flight);
  });
  
  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  
  function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
  }
  
  function isAirportCode(value: string): boolean {
    return /^[A-Z]{3}$/.test(value);
  }
  
  function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
  }
  
  function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }
  
  const ISO_DATETIME_WITH_TZ =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
  
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
  
  /**
   * Parse ISO-8601 with explicit timezone and reject non-existent calendar dates.
   * Do not trust `new Date()` alone — JS may overflow Feb 30 → Mar 2.
   */
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
  
  /**
   * Pure request validation: no access to `flights`, no HTTP, no mutation.
   * Returns either a trusted CreateFlightRequest or a list of issues.
   */
  function validateCreateFlightInput(
    input: unknown,
  ): ValidationResult<CreateFlightRequest> {
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
      "departureAt",
      "arrivalAt",
      "priceInCents",
      "currency",
      "availableSeats",
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
  
    // --- string fields: type + non-empty ---
    const stringFields = [
      "flightNumber",
      "origin",
      "destination",
      "departureAt",
      "arrivalAt",
      "currency",
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
  
    // Only normalize after we know values are strings
    const flightNumberRaw = input.flightNumber;
    const originRaw = input.origin;
    const destinationRaw = input.destination;
    const currencyRaw = input.currency;
    const departureRaw = input.departureAt;
    const arrivalRaw = input.arrivalAt;
  
    let flightNumber = "";
    let origin = "";
    let destination = "";
    let currency = "";
    let departureAtUtc: string | null = null;
    let arrivalAtUtc: string | null = null;
  
    if (isNonEmptyString(flightNumberRaw)) {
      flightNumber = flightNumberRaw.trim().toUpperCase();
    }
  
    if (isNonEmptyString(originRaw)) {
      origin = originRaw.trim().toUpperCase();
      if (!isAirportCode(origin)) {
        issues.push({
          field: "origin",
          code: "INVALID_AIRPORT_CODE",
          message: "Origin must be a three-letter airport code",
        });
      }
    }
  
    if (isNonEmptyString(destinationRaw)) {
      destination = destinationRaw.trim().toUpperCase();
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
  
    if (isNonEmptyString(currencyRaw)) {
      currency = currencyRaw.trim().toUpperCase();
      if (!SUPPORTED_CURRENCIES.has(currency)) {
        issues.push({
          field: "currency",
          code: "UNSUPPORTED_CURRENCY",
          message: "Currency must be VND or USD",
        });
      }
    }
  
    if (isNonEmptyString(departureRaw)) {
      departureAtUtc = tryParseUtcIso(departureRaw.trim());
      if (!departureAtUtc) {
        issues.push({
          field: "departureAt",
          code: "INVALID_DATETIME",
          message:
            "departureAt must be ISO-8601 with timezone (Z or ±HH:MM)",
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
      if (new Date(arrivalAtUtc).getTime() <= new Date(departureAtUtc).getTime()) {
        issues.push({
          field: "arrivalAt",
          code: "ARRIVAL_BEFORE_DEPARTURE",
          message: "arrivalAt must be after departureAt",
        });
      }
    }
  
    // --- numbers: no string coercion ---
    if ("priceInCents" in input && input.priceInCents !== undefined) {
      if (!isPositiveInteger(input.priceInCents)) {
        issues.push({
          field: "priceInCents",
          code: "INVALID_PRICE",
          message: "priceInCents must be an integer greater than 0",
        });
      }
    }
  
    if ("availableSeats" in input && input.availableSeats !== undefined) {
      if (!isNonNegativeInteger(input.availableSeats)) {
        issues.push({
          field: "availableSeats",
          code: "INVALID_AVAILABLE_SEATS",
          message: "availableSeats must be an integer greater than or equal to 0",
        });
      }
    }
  
    if (issues.length > 0) {
      return { success: false, issues };
    }
  
    return {
      success: true,
      value: {
        flightNumber,
        origin,
        destination,
        departureAt: departureAtUtc as string,
        arrivalAt: arrivalAtUtc as string,
        priceInCents: input.priceInCents as number,
        currency,
        availableSeats: input.availableSeats as number,
      },
    };
  }
  
  function findDuplicateFlight(
    store: Flight[],
    flightNumber: string,
    departureAt: string,
  ): Flight | undefined {
    return store.find(
      (flight) =>
        flight.flightNumber === flightNumber &&
        flight.departureAt === departureAt,
    );
  }
  
  app.post("/api/flights", (req, res) => {
    const rawBody: unknown = req.body;
    const result = validateCreateFlightInput(rawBody);

    if (!result.success) {
      return sendApiError(res, 422, {
        code: "VALIDATION_FAILED",
        message: "Request contains invalid flight data",
        details: result.issues,
      });
    }

    const validated = result.value;

    const duplicate = findDuplicateFlight(
      flights,
      validated.flightNumber,
      validated.departureAt,
    );

    if (duplicate) {
      return sendApiError(res, 409, {
        code: "FLIGHT_ALREADY_EXISTS",
        message:
          "A flight with the same flight number and departure time already exists",
      });
    }

    // Explicit mapping — never spread req.body
    const flight: Flight = {
      id: crypto.randomUUID(),
      flightNumber: validated.flightNumber,
      origin: validated.origin,
      destination: validated.destination,
      departureAt: validated.departureAt,
      arrivalAt: validated.arrivalAt,
      priceInCents: validated.priceInCents,
      currency: validated.currency,
      availableSeats: validated.availableSeats,
    };

    flights.push(flight);

    res.setHeader("Location", `/api/flights/${flight.id}`);
    return res.status(201).json(flight);
  });

  // After all routes: unmatched path → 404; parser/unexpected → errorHandler
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}