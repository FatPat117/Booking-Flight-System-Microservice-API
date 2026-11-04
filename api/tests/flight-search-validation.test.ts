import assert from "node:assert/strict";
import test from "node:test";

import { validateFlightSearchQuery } from "../src/flights/flight-search-validation.js";

const VALID = { origin: "SGN", destination: "HAN", departureDateFrom: "2026-12-01" };

function codesOf(raw: Record<string, unknown>): string[] {
  const result = validateFlightSearchQuery(raw);
  return result.success ? [] : result.issues.map((issue) => `${issue.field}:${issue.code}`);
}

test("defaults: one local date, 1 passenger, by departure, 20 per page; codes upper-cased", () => {
  assert.deepEqual(validateFlightSearchQuery({ ...VALID, origin: " sgn " }), {
    success: true,
    value: {
      query: {
        origin: "SGN",
        destination: "HAN",
        departureDateFrom: "2026-12-01",
        departureDateTo: "2026-12-01",
        passengers: 1,
        sort: "departure",
        limit: 20,
      },
      cursor: undefined,
    },
  });
});

test("route: both codes required, three letters, and different", () => {
  assert.deepEqual(codesOf({ departureDateFrom: "2026-12-01" }), ["origin:MISSING_FIELD", "destination:MISSING_FIELD"]);
  assert.deepEqual(codesOf({ ...VALID, origin: "SG1" }), ["origin:INVALID_AIRPORT_CODE"]);
  assert.deepEqual(codesOf({ ...VALID, destination: "SGN" }), ["destination:ORIGIN_EQUALS_DESTINATION"]);
});

test("a repeated query parameter arrives as an array and is invalid, not its first value", () => {
  assert.deepEqual(codesOf({ ...VALID, origin: ["SGN", "DAD"] }), ["origin:INVALID_AIRPORT_CODE"]);
  assert.deepEqual(codesOf({ ...VALID, cursor: ["a", "b"] }), ["cursor:INVALID_CURSOR"]);
});

test("dates: a calendar date that exists (2026-02-30 does not, US-FLT-04), and an ordered range", () => {
  assert.deepEqual(codesOf({ ...VALID, departureDateFrom: "2026-02-30" }), ["departureDateFrom:INVALID_DATE"]);
  assert.deepEqual(codesOf({ ...VALID, departureDateFrom: "2026-12-1" }), ["departureDateFrom:INVALID_DATE"]);
  assert.deepEqual(codesOf({ ...VALID, departureDateFrom: undefined }), ["departureDateFrom:MISSING_FIELD"]);
  assert.deepEqual(codesOf({ ...VALID, departureDateTo: "2026-11-30" }), ["departureDateTo:INVALID_DATE_RANGE"]);
  assert.deepEqual(codesOf({ ...VALID, departureDateFrom: "2028-02-29", departureDateTo: "2028-02-29" }), []);
});

test("at most 7 local dates: the 1st to the 7th is allowed, the 1st to the 8th is not", () => {
  assert.deepEqual(codesOf({ ...VALID, departureDateTo: "2026-12-07" }), []);
  assert.deepEqual(codesOf({ ...VALID, departureDateTo: "2026-12-08" }), ["departureDateTo:DATE_RANGE_TOO_LONG"]);
});

test("passengers 1–9 (BR-BOOK-01), sort departure|price, limit 1–50", () => {
  for (const passengers of ["0", "10", "2.5", "-1", "two"]) {
    assert.deepEqual(codesOf({ ...VALID, passengers }), ["passengers:INVALID_PASSENGER_COUNT"], passengers);
  }
  assert.deepEqual(codesOf({ ...VALID, passengers: "9" }), []);
  assert.deepEqual(codesOf({ ...VALID, sort: "duration" }), ["sort:INVALID_SORT"]);
  assert.deepEqual(codesOf({ ...VALID, limit: "51" }), ["limit:INVALID_LIMIT"]);
  assert.deepEqual(codesOf({ ...VALID, limit: "50", sort: "price" }), []);
});

test("every problem is reported at once", () => {
  assert.deepEqual(codesOf({ origin: "X", destination: "HAN", departureDateFrom: "nope", passengers: "10", limit: "0" }), [
    "origin:INVALID_AIRPORT_CODE",
    "departureDateFrom:INVALID_DATE",
    "passengers:INVALID_PASSENGER_COUNT",
    "limit:INVALID_LIMIT",
  ]);
});
