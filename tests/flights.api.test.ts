import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";

type FlightPayload = {
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  priceInCents: number;
  currency: string;
  availableSeats: number;
  [key: string]: unknown;
};

function makeValidFlight(
  overrides: Partial<FlightPayload> = {},
): FlightPayload {
  return {
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T08:00:00+07:00",
    arrivalAt: "2026-08-10T10:00:00+07:00",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 120,
    ...overrides,
  };
}

async function postRawJson(app: Express, rawJson: string) {
  return request(app)
    .post("/api/flights")
    .set("Content-Type", "application/json")
    .send(rawJson);
}

function assertValidationFailed(
  body: unknown,
  expectedIssueCode?: string,
  expectedField?: string,
) {
  assert.ok(body && typeof body === "object");
  const error = (body as { error?: Record<string, unknown> }).error;
  assert.ok(error);
  assert.equal(error.code, "VALIDATION_FAILED");
  assert.ok(Array.isArray(error.details));

  if (expectedIssueCode) {
    const details = error.details as Array<{ code: string; field: string }>;
    const match = details.find(
      (issue) =>
        issue.code === expectedIssueCode &&
        (expectedField === undefined || issue.field === expectedField),
    );
    assert.ok(
      match,
      `Expected issue code ${expectedIssueCode}` +
        (expectedField ? ` on field ${expectedField}` : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// Health & reads
// ---------------------------------------------------------------------------

test("GET /health returns application health", async () => {
  const app = createApp();
  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("GET /api/flights returns empty collection", async () => {
  const app = createApp();
  const response = await request(app).get("/api/flights");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
});

test("GET /api/flights/:id returns 404 for missing flight", async () => {
  const app = createApp();
  const response = await request(app).get("/api/flights/not-found-id");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Successful creation contract
// ---------------------------------------------------------------------------

test("POST /api/flights creates a normalized flight with Location header", async () => {
  const app = createApp();

  const response = await request(app)
    .post("/api/flights")
    .send(
      makeValidFlight({
        flightNumber: "vn123",
        origin: " sgn ",
        destination: "han",
        currency: "vnd",
        isAdmin: true,
        internalStatus: "APPROVED",
      }),
    );

  assert.equal(response.status, 201);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);

  assert.equal(typeof response.body.id, "string");
  assert.ok(response.body.id.length > 0);
  assert.equal(response.headers.location, `/api/flights/${response.body.id}`);

  assert.equal(response.body.flightNumber, "VN123");
  assert.equal(response.body.origin, "SGN");
  assert.equal(response.body.destination, "HAN");
  assert.equal(response.body.currency, "VND");
  assert.equal(response.body.departureAt, "2026-08-10T01:00:00.000Z");
  assert.equal(response.body.arrivalAt, "2026-08-10T03:00:00.000Z");
  assert.equal(response.body.priceInCents, 15_000_000);
  assert.equal(response.body.availableSeats, 120);
  assert.equal(response.body.isAdmin, undefined);
  assert.equal(response.body.internalStatus, undefined);

  const getResponse = await request(app).get(
    `/api/flights/${response.body.id}`,
  );
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.id, response.body.id);
  assert.equal(getResponse.body.flightNumber, "VN123");
});

test("POST /api/flights accepts availableSeats = 0", async () => {
  const app = createApp();

  const response = await request(app)
    .post("/api/flights")
    .send(makeValidFlight({ availableSeats: 0 }));

  assert.equal(response.status, 201);
  assert.equal(response.body.availableSeats, 0);
});

// ---------------------------------------------------------------------------
// Top-level body shape
// ---------------------------------------------------------------------------

test("rejects valid JSON primitives and arrays with INVALID_BODY", async (t) => {
  const cases = [
    { name: "null", raw: "null" },
    { name: "string", raw: '"hello"' },
    { name: "number", raw: "123" },
    { name: "array", raw: "[]" },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const app = createApp();
      const response = await postRawJson(app, testCase.raw);

      assert.equal(response.status, 422);
      assertValidationFailed(response.body, "INVALID_BODY", "body");
    });
  }
});

test("malformed JSON returns 400 MALFORMED_JSON as JSON", async () => {
  const app = createApp();
  const response = await postRawJson(app, '{"flightNumber":');

  assert.equal(response.status, 400);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  assert.equal(response.body.error.code, "MALFORMED_JSON");
  assert.equal(typeof response.body.error.message, "string");
  assert.equal(response.body.error.stack, undefined);
  assert.equal(response.body.stack, undefined);
  assert.ok(!JSON.stringify(response.body).includes("flightNumber"));
});

test("GET /api/unknown returns 404 ROUTE_NOT_FOUND", async () => {
  const app = createApp();
  const response = await request(app).get("/api/unknown");

  assert.equal(response.status, 404);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
});

test("PUT /api/flights currently resolves as ROUTE_NOT_FOUND", async () => {
  const app = createApp();
  const response = await request(app).put("/api/flights").send(makeValidFlight());

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
});

test("unexpected errors return generic 500 without leaking internals", async () => {
  const express = (await import("express")).default;
  const { errorHandler } = await import("../src/http-errors.js");

  const testApp = express();
  testApp.get("/boom", () => {
    throw new Error("sensitive internal message");
  });
  testApp.use(errorHandler);

  const response = await request(testApp).get("/boom");

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "INTERNAL_SERVER_ERROR");
  assert.equal(typeof response.body.error.message, "string");
  assert.ok(!JSON.stringify(response.body).includes("sensitive internal message"));
  assert.equal(response.body.error.stack, undefined);
  assert.equal(response.body.stack, undefined);
});

// ---------------------------------------------------------------------------
// Required fields & primitive types
// ---------------------------------------------------------------------------

test("rejects empty object with missing fields", async () => {
  const app = createApp();
  const response = await request(app).post("/api/flights").send({});

  assert.equal(response.status, 422);
  assertValidationFailed(response.body);
  assert.ok(response.body.error.details.length >= 8);
});

test("rejects wrong primitive types and empty strings", async (t) => {
  const cases = [
    {
      name: "number instead of string flightNumber",
      override: { flightNumber: 123 as unknown as string },
      code: "INVALID_STRING",
      field: "flightNumber",
    },
    {
      name: "string instead of number priceInCents",
      override: { priceInCents: "15000000" as unknown as number },
      code: "INVALID_PRICE",
      field: "priceInCents",
    },
    {
      name: "whitespace-only origin",
      override: { origin: "   " },
      code: "INVALID_STRING",
      field: "origin",
    },
    {
      name: "fractional price",
      override: { priceInCents: 10.5 },
      code: "INVALID_PRICE",
      field: "priceInCents",
    },
    {
      name: "negative seats",
      override: { availableSeats: -1 },
      code: "INVALID_AVAILABLE_SEATS",
      field: "availableSeats",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const app = createApp();
      const response = await request(app)
        .post("/api/flights")
        .send(makeValidFlight(testCase.override));

      assert.equal(response.status, 422);
      assertValidationFailed(response.body, testCase.code, testCase.field);
    });
  }
});

// ---------------------------------------------------------------------------
// Business invariants
// ---------------------------------------------------------------------------

test("rejects business invariant violations", async (t) => {
  const cases = [
    {
      name: "origin equals destination",
      override: { origin: "SGN", destination: "sgn" },
      code: "ORIGIN_EQUALS_DESTINATION",
    },
    {
      name: "arrival before departure",
      override: {
        departureAt: "2026-08-10T10:00:00Z",
        arrivalAt: "2026-08-10T08:00:00Z",
      },
      code: "ARRIVAL_BEFORE_DEPARTURE",
    },
    {
      name: "arrival equals departure",
      override: {
        departureAt: "2026-08-10T08:00:00Z",
        arrivalAt: "2026-08-10T08:00:00Z",
      },
      code: "ARRIVAL_BEFORE_DEPARTURE",
    },
    {
      name: "unsupported currency",
      override: { currency: "EUR" },
      code: "UNSUPPORTED_CURRENCY",
    },
    {
      name: "invalid airport code",
      override: { origin: "SAIGON" },
      code: "INVALID_AIRPORT_CODE",
      field: "origin",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const app = createApp();
      const response = await request(app)
        .post("/api/flights")
        .send(makeValidFlight(testCase.override));

      assert.equal(response.status, 422);
      assertValidationFailed(
        response.body,
        testCase.code,
        "field" in testCase ? testCase.field : undefined,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Calendar edge cases
// ---------------------------------------------------------------------------

test("calendar date validation", async (t) => {
  const rejectCases = [
    {
      name: "rejects non-leap Feb 29 2026",
      departureAt: "2026-02-29T08:00:00Z",
      arrivalAt: "2026-02-29T10:00:00Z",
    },
    {
      name: "rejects Feb 30",
      departureAt: "2026-02-30T08:00:00Z",
      arrivalAt: "2026-03-02T10:00:00Z",
    },
    {
      name: "rejects Apr 31",
      departureAt: "2026-04-31T08:00:00Z",
      arrivalAt: "2026-05-01T10:00:00Z",
    },
    {
      name: "rejects month 13",
      departureAt: "2026-13-01T08:00:00Z",
      arrivalAt: "2026-13-01T10:00:00Z",
    },
    {
      name: "rejects hour 25",
      departureAt: "2026-01-01T25:00:00Z",
      arrivalAt: "2026-01-01T26:00:00Z",
    },
    {
      name: "rejects minute 60",
      departureAt: "2026-01-01T08:60:00Z",
      arrivalAt: "2026-01-01T10:00:00Z",
    },
    {
      name: "rejects second 60",
      departureAt: "2026-01-01T08:00:60Z",
      arrivalAt: "2026-01-01T10:00:00Z",
    },
  ];

  for (const testCase of rejectCases) {
    await t.test(testCase.name, async () => {
      const app = createApp();
      const response = await request(app)
        .post("/api/flights")
        .send(
          makeValidFlight({
            departureAt: testCase.departureAt,
            arrivalAt: testCase.arrivalAt,
          }),
        );

      assert.equal(response.status, 422);
      assertValidationFailed(response.body, "INVALID_DATETIME");
    });
  }

  await t.test("accepts leap day 2028-02-29", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/api/flights")
      .send(
        makeValidFlight({
          departureAt: "2028-02-29T08:00:00Z",
          arrivalAt: "2028-02-29T10:00:00Z",
        }),
      );

    assert.equal(response.status, 201);
    assert.equal(response.body.departureAt, "2028-02-29T08:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Duplicate & mutation safety
// ---------------------------------------------------------------------------

test("duplicate flightNumber + departure instant returns 409 and keeps one record", async () => {
  const app = createApp();

  const first = await request(app)
    .post("/api/flights")
    .send(makeValidFlight());

  assert.equal(first.status, 201);

  const second = await request(app)
    .post("/api/flights")
    .send(
      makeValidFlight({
        flightNumber: "vn123",
        departureAt: "2026-08-10T01:00:00Z",
        arrivalAt: "2026-08-10T03:00:00Z",
      }),
    );

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "FLIGHT_ALREADY_EXISTS");

  const list = await request(app).get("/api/flights");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
});

test("invalid request does not mutate collection", async () => {
  const app = createApp();

  const before = await request(app).get("/api/flights");
  assert.equal(before.body.length, 0);

  const invalid = await request(app).post("/api/flights").send({});
  assert.equal(invalid.status, 422);

  const after = await request(app).get("/api/flights");
  assert.equal(after.body.length, 0);
});

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

test("isolation A: creating a flight does not leak to other apps", async () => {
  const app = createApp();
  const created = await request(app)
    .post("/api/flights")
    .send(makeValidFlight());
  assert.equal(created.status, 201);

  const list = await request(app).get("/api/flights");
  assert.equal(list.body.length, 1);
});

test("isolation B: fresh app starts with empty collection", async () => {
  const app = createApp();
  const list = await request(app).get("/api/flights");

  assert.equal(list.status, 200);
  assert.deepEqual(list.body, []);
});
