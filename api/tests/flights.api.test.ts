import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

import { createApp } from "../src/app.js";
import type { AuditRecorder } from "../src/audit/audit-recorder.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createNoopOutboxRepository } from "../src/outbox/noop-outbox-repository.js";
import type { FlightRepository } from "../src/flights/flight-repository.js";
import { createGetFlight } from "../src/flights/get-flight.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createOpenFlight } from "../src/flights/open-flight.js";
import type { HealthChecks } from "../src/health/health-checks.js";
import type { Logger, LogFields } from "../src/observability/logger.js";
import { getRequestContext } from "../src/observability/request-context.js";
import { TEST_AIRCRAFT, TEST_AIRPORTS } from "./fixtures/flights.js";
import {
  createInMemoryAircraftRepository,
  createInMemoryAirportRepository,
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
  createUnusedBookingReads,
  createUnusedReferenceData,
  type InMemoryAuditRecorder,
  type InMemoryFlightStore,
} from "./fakes/in-memory.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";
// Before every departure below, so the effective status is the stored one
// unless a test picks a departure close to it.
const NOW = new Date("2026-07-01T00:00:00.000Z");

function signAccessToken(role: "user" | "admin" = "admin"): string {
  return jwt.sign(
    {
      sub: "test-user-id",
      email: role === "admin" ? "admin@example.com" : "user@example.com",
      role,
    },
    TEST_JWT_SECRET,
    { expiresIn: "1h" },
  );
}

type FlightPayload = {
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  priceInCents: number;
  currency: string;
  aircraftRegistration: string;
  [key: string]: unknown;
};

function createMemoryLogger() {
  const entries: Array<{
    level: string;
    message: string;
    fields?: LogFields;
  }> = [];

  const logger: Logger = {
    info(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "info", message }
          : { level: "info", message, fields },
      );
    },
    warn(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "warn", message }
          : { level: "warn", message, fields },
      );
    },
    error(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "error", message }
          : { level: "error", message, fields },
      );
    },
  };

  return { logger, entries };
}

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
    aircraftRegistration: "VN-A321",
    ...overrides,
  };
}

const healthyHealthChecks: HealthChecks = {
  async checkReadiness() {
    return {
      status: "ok",
      checks: {
        database: {
          status: "ok",
        },
      },
    };
  },
};

function createAppWithRepository(
  flightRepository: FlightRepository,
  deps: {
    flights: InMemoryFlightStore;
    auditRecorder: AuditRecorder;
    healthChecks?: HealthChecks;
  },
) {
  const { flights, auditRecorder, healthChecks = healthyHealthChecks } = deps;
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const transactionRunner = createInMemoryTransactionRunner();

  const createFlight = createCreateFlight({
    flightRepository,
    airportRepository: createInMemoryAirportRepository(TEST_AIRPORTS),
    aircraftRepository: createInMemoryAircraftRepository(TEST_AIRCRAFT),
    auditRecorder,
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => NOW,
  });

  const openFlight = createOpenFlight({
    flightRepository,
    auditRecorder,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => NOW,
  });

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => NOW,
  });

  const listFlights = createListFlights({
    flightRepository,
    getCurrentTime: () => NOW,
  });

  const { logger } = createMemoryLogger();

  return createApp({
    getFlight: createGetFlight({ flightRepository, getCurrentTime: () => NOW }),
    createFlight,
    openFlight,
    createBooking,
    cancelBooking: async () => ({ outcome: "not-found" as const }),
    ...createUnusedBookingReads(),
    ...createUnusedReferenceData(),
    listFlights,
    logger,
    healthChecks,
    jwtSecret: TEST_JWT_SECRET,
  });
}

function withAdminAuth(builder: request.Test) {
  return builder.set("Authorization", `Bearer ${signAccessToken("admin")}`);
}

function postFlight(app: Express) {
  return withAdminAuth(request(app).post("/api/flights"));
}

function createTestContext(): {
  app: Express;
  audit: InMemoryAuditRecorder;
  repository: FlightRepository;
} {
  const flights = createInMemoryFlightStore();
  const repository = createInMemoryFlightRepository(flights);
  const audit = createInMemoryAuditRecorder();
  const app = createAppWithRepository(repository, {
    flights,
    auditRecorder: audit,
  });

  return { app, audit, repository };
}

async function postRawJson(app: Express, rawJson: string) {
  return withAdminAuth(
    request(app)
      .post("/api/flights")
      .set("Content-Type", "application/json"),
  ).send(rawJson);
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
  const { app } = createTestContext();
  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("GET /api/flights returns an empty paginated collection", async () => {
  const { app } = createTestContext();
  const response = await request(app).get("/api/flights");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    items: [],
    pagination: {
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    },
  });
});

test("GET /api/flights/:id returns 404 for missing flight", async () => {
  const { app } = createTestContext();
  const response = await request(app).get(
    "/api/flights/c0ffee00-0000-4000-8000-000000000000",
  );

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
});

test("GET /api/flights/:id with a malformed id is 404 and never reaches the repository", async () => {
  const flights = createInMemoryFlightStore();
  const repository = createInMemoryFlightRepository(flights);
  // Stands in for Postgres rejecting a non-uuid with 22P02 (→ 500 before Day 45).
  const app = createAppWithRepository(
    {
      ...repository,
      async findById() {
        throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
      },
    },
    { flights, auditRecorder: createInMemoryAuditRecorder() },
  );

  const response = await request(app).get("/api/flights/not-a-uuid");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Successful creation contract
// ---------------------------------------------------------------------------

test("POST /api/flights creates a normalized flight with Location header", async () => {
  const { app } = createTestContext();

  const response = await postFlight(app)
    .send(
      makeValidFlight({
        flightNumber: "vn123",
        origin: " sgn ",
        destination: "han",
        currency: "vnd",
        aircraftRegistration: " vn-a321 ",
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
  assert.equal(response.body.status, "SCHEDULED");
  assert.equal(response.body.aircraftId, TEST_AIRCRAFT[0]?.id);
  assert.equal(response.body.originAirportId, TEST_AIRPORTS[2]?.id);
  assert.equal(response.body.isAdmin, undefined);
  assert.equal(response.body.internalStatus, undefined);
  assert.equal(response.body.flight_number, undefined);

  const getResponse = await request(app).get(
    `/api/flights/${response.body.id}`,
  );
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.id, response.body.id);
  assert.equal(getResponse.body.flightNumber, "VN123");
});

test("POST /api/flights takes its seat count from the aircraft's layout", async () => {
  const { app } = createTestContext();

  const response = await postFlight(app)
    .send(makeValidFlight({ aircraftRegistration: "VN-A322" }));

  assert.equal(response.status, 201);
  assert.equal(response.body.availableSeats, 5);
});

test("POST /api/flights rejects availableSeats: capacity is no longer client-set (Day 46)", async () => {
  const { app } = createTestContext();

  const response = await postFlight(app)
    .send(makeValidFlight({ availableSeats: 300 }));

  assert.equal(response.status, 422);
  assert.deepEqual(
    response.body.error.details.map((issue: { field: string; code: string }) => [
      issue.field,
      issue.code,
    ]),
    [["availableSeats", "UNSUPPORTED_FIELD"]],
  );
});

test("POST /api/flights names every unknown airport and aircraft at once (422)", async () => {
  const { app } = createTestContext();

  const response = await postFlight(app).send(
    makeValidFlight({
      origin: "XXX",
      destination: "YYY",
      aircraftRegistration: "VN-NOPE",
    }),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(
    response.body.error.details.map((issue: { field: string; code: string }) => [
      issue.field,
      issue.code,
    ]),
    [
      ["origin", "UNKNOWN_AIRPORT"],
      ["destination", "UNKNOWN_AIRPORT"],
      ["aircraftRegistration", "UNKNOWN_AIRCRAFT"],
    ],
  );
});

test("POST /api/flights on an aircraft that is still flying (or turning around) is 409 AIRCRAFT_UNAVAILABLE", async () => {
  const { app } = createTestContext();

  const first = await postFlight(app).send(makeValidFlight());
  assert.equal(first.status, 201);

  // First lands 10:00 local; the aircraft is busy until 10:45 (BR-FLT-08).
  const tooSoon = await postFlight(app).send(
    makeValidFlight({
      flightNumber: "VN124",
      origin: "HAN",
      destination: "SGN",
      departureAt: "2026-08-10T10:30:00+07:00",
      arrivalAt: "2026-08-10T12:30:00+07:00",
    }),
  );
  assert.equal(tooSoon.status, 409);
  assert.equal(tooSoon.body.error.code, "AIRCRAFT_UNAVAILABLE");

  const afterTurnaround = await postFlight(app).send(
    makeValidFlight({
      flightNumber: "VN124",
      origin: "HAN",
      destination: "SGN",
      departureAt: "2026-08-10T10:45:00+07:00",
      arrivalAt: "2026-08-10T12:45:00+07:00",
    }),
  );
  assert.equal(afterTurnaround.status, 201);
});

// ---------------------------------------------------------------------------
// Opening a flight for sale (US-FLT-02)
// ---------------------------------------------------------------------------

function postOpen(app: Express, flightId: string) {
  return withAdminAuth(request(app).post(`/api/flights/${flightId}/open`));
}

async function createScheduledFlight(
  app: Express,
  overrides: Partial<FlightPayload> = {},
): Promise<string> {
  const response = await postFlight(app).send(makeValidFlight(overrides));
  assert.equal(response.status, 201);
  assert.equal(response.body.status, "SCHEDULED");
  return response.body.id as string;
}

test("POST /api/flights/:id/open opens a scheduled flight and audits who did it", async () => {
  const { app, audit } = createTestContext();
  const flightId = await createScheduledFlight(app);

  const response = await postOpen(app, flightId).set("x-request-id", "open-1");

  assert.equal(response.status, 200);
  assert.equal(response.body.id, flightId);
  assert.equal(response.body.status, "OPEN");
  assert.equal((await request(app).get(`/api/flights/${flightId}`)).body.status, "OPEN");

  const opened = audit.records.find((record) => record.action === "FLIGHT_OPENED");
  assert.ok(opened);
  assert.deepEqual(opened.actor, { type: "account", id: "test-user-id" });
  assert.deepEqual(opened.target, { type: "flight", id: flightId });
  assert.equal(opened.requestId, "open-1");
  assert.deepEqual(opened.metadata, {
    flightNumber: "VN123",
    previousStatus: "SCHEDULED",
  });
});

test("opening an already open flight is 409 INVALID_FLIGHT_STATUS (NOT_ALLOWED), audited once", async () => {
  const { app, audit } = createTestContext();
  const flightId = await createScheduledFlight(app);
  assert.equal((await postOpen(app, flightId)).status, 200);

  const again = await postOpen(app, flightId);

  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "INVALID_FLIGHT_STATUS");
  assert.deepEqual(
    again.body.error.details.map((issue: { field: string; code: string }) => [
      issue.field,
      issue.code,
    ]),
    [["status", "NOT_ALLOWED"]],
  );
  assert.equal(
    audit.records.filter((record) => record.action === "FLIGHT_OPENED").length,
    1,
  );
});

test("opening a flight that departs in 1 hour or less is 409 DEPARTURE_TOO_SOON and it stays SCHEDULED", async () => {
  const { app } = createTestContext();
  // NOW + 1 h exactly: the guard needs *more* than 1 hour (BR-FLT-05/06).
  const flightId = await createScheduledFlight(app, {
    departureAt: "2026-07-01T01:00:00Z",
    arrivalAt: "2026-07-01T03:00:00Z",
  });

  const response = await postOpen(app, flightId);

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "INVALID_FLIGHT_STATUS");
  assert.equal(response.body.error.details[0].code, "DEPARTURE_TOO_SOON");
  assert.equal((await request(app).get(`/api/flights/${flightId}`)).body.status, "SCHEDULED");
});

test("losing the compare-and-set to a concurrent open is 409 FLIGHT_STATUS_CHANGED with no audit", async () => {
  const flights = createInMemoryFlightStore();
  const inner = createInMemoryFlightRepository(flights);
  const audit = createInMemoryAuditRecorder();
  // Another admin's open lands between this request's read and its write.
  const racing: FlightRepository = {
    ...inner,
    async changeStatus(flightId, expected, next) {
      await inner.changeStatus(flightId, "SCHEDULED", "OPEN");
      return inner.changeStatus(flightId, expected, next);
    },
  };
  const app = createAppWithRepository(racing, { flights, auditRecorder: audit });
  const flightId = await createScheduledFlight(app);

  const response = await postOpen(app, flightId);

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "FLIGHT_STATUS_CHANGED");
  assert.match(response.body.error.message, /now OPEN/);
  assert.equal(
    audit.records.filter((record) => record.action === "FLIGHT_OPENED").length,
    0,
  );
});

test("opening an unknown or malformed flight id is 404 FLIGHT_NOT_FOUND", async () => {
  const { app } = createTestContext();

  const unknown = await postOpen(app, "c0ffee00-0000-4000-8000-000000000000");
  const malformed = await postOpen(app, "not-a-uuid");

  for (const response of [unknown, malformed]) {
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
  }
});

test("only an admin can open a flight: 401 without a token, 403 for a user", async () => {
  const { app } = createTestContext();
  const flightId = await createScheduledFlight(app);

  const anonymous = await request(app).post(`/api/flights/${flightId}/open`);
  const user = await request(app)
    .post(`/api/flights/${flightId}/open`)
    .set("Authorization", `Bearer ${signAccessToken("user")}`);

  assert.equal(anonymous.status, 401);
  assert.equal(user.status, 403);
  assert.equal((await request(app).get(`/api/flights/${flightId}`)).body.status, "SCHEDULED");
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
      const { app } = createTestContext();
      const response = await postRawJson(app, testCase.raw);

      assert.equal(response.status, 422);
      assertValidationFailed(response.body, "INVALID_BODY", "body");
    });
  }
});

test("malformed JSON returns 400 MALFORMED_JSON as JSON", async () => {
  const { app } = createTestContext();
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
  const { app } = createTestContext();
  const response = await request(app).get("/api/unknown");

  assert.equal(response.status, 404);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
});

test("PUT /api/flights currently resolves as ROUTE_NOT_FOUND", async () => {
  const { app } = createTestContext();
  const response = await request(app)
    .put("/api/flights")
    .send(makeValidFlight());

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
});

test("unexpected errors return generic 500 without leaking internals", async () => {
  const express = (await import("express")).default;
  const { createErrorHandler } = await import("../src/http-errors.js");
  const { logger } = createMemoryLogger();

  const testApp = express();
  testApp.get("/boom", () => {
    throw new Error("sensitive internal message");
  });
  testApp.use(createErrorHandler(logger));

  const response = await request(testApp).get("/boom");

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "INTERNAL_SERVER_ERROR");
  assert.equal(typeof response.body.error.message, "string");
  assert.ok(
    !JSON.stringify(response.body).includes("sensitive internal message"),
  );
  assert.equal(response.body.error.stack, undefined);
  assert.equal(response.body.stack, undefined);
});

// ---------------------------------------------------------------------------
// Required fields & primitive types
// ---------------------------------------------------------------------------

test("rejects empty object with missing fields", async () => {
  const { app } = createTestContext();
  const response = await postFlight(app).send({});

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
      name: "empty aircraftRegistration",
      override: { aircraftRegistration: "" },
      code: "INVALID_STRING",
      field: "aircraftRegistration",
    },
    {
      name: "unsafe integer price",
      override: { priceInCents: Number.MAX_SAFE_INTEGER + 1 },
      code: "INVALID_PRICE",
      field: "priceInCents",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { app } = createTestContext();
      const response = await postFlight(app)
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
      const { app } = createTestContext();
      const response = await postFlight(app)
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
      const { app } = createTestContext();
      const response = await postFlight(app)
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
    const { app } = createTestContext();
    const response = await postFlight(app)
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
  const { app } = createTestContext();

  const first = await postFlight(app).send(makeValidFlight());
  assert.equal(first.status, 201);

  const second = await postFlight(app)
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
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.pagination.totalItems, 1);
});

test("invalid request does not mutate collection", async () => {
  const { app } = createTestContext();

  const before = await request(app).get("/api/flights");
  assert.equal(before.body.items.length, 0);

  const invalid = await postFlight(app).send({});
  assert.equal(invalid.status, 422);

  const after = await request(app).get("/api/flights");
  assert.equal(after.body.items.length, 0);
});

test("repository unexpected failure returns generic 500 without leaking internals", async () => {
  const failingRepository: FlightRepository = {
    findPage() {
      throw new Error("sensitive database failure");
    },
    findById() {
      throw new Error("sensitive database failure");
    },
    create() {
      throw new Error("sensitive database failure");
    },
    changeStatus() {
      throw new Error("sensitive database failure");
    },
  };

  const app = createAppWithRepository(failingRepository, {
    flights: createInMemoryFlightStore(),
    auditRecorder: createInMemoryAuditRecorder(),
  });
  const response = await request(app).get("/api/flights");

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "INTERNAL_SERVER_ERROR");
  assert.ok(
    !JSON.stringify(response.body).includes("sensitive database failure"),
  );
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test("GET /api/flights returns the requested page", async () => {
  const { app } = createTestContext();

  const departures = [
    "2026-08-11T08:00:00Z",
    "2026-08-12T08:00:00Z",
    "2026-08-13T08:00:00Z",
    "2026-08-14T08:00:00Z",
    "2026-08-15T08:00:00Z",
  ];

  for (let index = 0; index < departures.length; index += 1) {
    const departureAt = departures[index]!;
    const arrivalDate = new Date(departureAt);
    arrivalDate.setUTCHours(arrivalDate.getUTCHours() + 2);

    const response = await postFlight(app)
      .send(
        makeValidFlight({
          flightNumber: `VN10${index + 1}`,
          departureAt,
          arrivalAt: arrivalDate.toISOString(),
        }),
      );

    assert.equal(response.status, 201);
  }

  const response = await request(app).get(
    "/api/flights?page=2&pageSize=2",
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  assert.deepEqual(
    response.body.items.map(
      (flight: { flightNumber: string }) => flight.flightNumber,
    ),
    ["VN103", "VN104"],
  );
  assert.deepEqual(response.body.pagination, {
    page: 2,
    pageSize: 2,
    totalItems: 5,
    totalPages: 3,
  });
});

test("GET /api/flights rejects invalid page", async () => {
  const { app } = createTestContext();
  const response = await request(app).get("/api/flights?page=0");

  assert.equal(response.status, 422);
  assertValidationFailed(response.body, "INVALID_PAGE", "page");
});

test("GET /api/flights rejects pageSize above maximum", async () => {
  const { app } = createTestContext();
  const response = await request(app).get("/api/flights?pageSize=101");

  assert.equal(response.status, 422);
  assertValidationFailed(response.body, "INVALID_PAGE_SIZE", "pageSize");
});

test("GET /api/flights rejects repeated page parameters", async () => {
  const { app } = createTestContext();
  const response = await request(app).get("/api/flights?page=1&page=2");

  assert.equal(response.status, 422);
  assertValidationFailed(response.body, "INVALID_PAGE", "page");
});

test("GET /api/flights returns an empty page beyond the end", async () => {
  const { app } = createTestContext();

  const created = await postFlight(app)
    .send(makeValidFlight());

  assert.equal(created.status, 201);

  const response = await request(app).get(
    "/api/flights?page=10&pageSize=2",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, []);
  assert.deepEqual(response.body.pagination, {
    page: 10,
    pageSize: 2,
    totalItems: 1,
    totalPages: 1,
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

test("POST /api/flights records an audit log when created", async () => {
  const { app, audit, repository } = createTestContext();

  const response = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${signAccessToken("admin")}`)
    .set("x-request-id", "audit-request-1")
    .send(makeValidFlight());

  assert.equal(response.status, 201);

  const createdFlightId = response.body.id;

  assert.ok(await repository.findById(createdFlightId));

  const records = audit.records;
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record);
  assert.equal(record.action, "FLIGHT_CREATED");
  assert.deepEqual(record.actor, { type: "account", id: "test-user-id" });
  assert.deepEqual(record.target, { type: "flight", id: createdFlightId });
  assert.equal(record.requestId, "audit-request-1");
  assert.deepEqual(record.metadata, {
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    aircraftRegistration: "VN-A321",
    correlationId: "audit-request-1",
  });
});

test("unauthenticated create request does not record audit", async () => {
  const { app, audit } = createTestContext();

  const response = await request(app)
    .post("/api/flights")
    .send(makeValidFlight());

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "MISSING_TOKEN");

  assert.equal(audit.records.length, 0);
});

test("non-admin JWT cannot create flight", async () => {
  const { app, audit } = createTestContext();

  const response = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${signAccessToken("user")}`)
    .send(makeValidFlight());

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN");

  assert.equal(audit.records.length, 0);
});

test("invalid create request does not record audit", async () => {
  const { app, audit } = createTestContext();

  const response = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${signAccessToken("admin")}`)
    .send({});

  assert.equal(response.status, 422);

  assert.equal(audit.records.length, 0);
});

test("duplicate create request does not record an additional audit log", async () => {
  const { app, audit } = createTestContext();

  const payload = makeValidFlight();

  const first = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${signAccessToken("admin")}`)
    .send(payload);

  assert.equal(first.status, 201);

  const duplicate = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${signAccessToken("admin")}`)
    .send(payload);

  assert.equal(duplicate.status, 409);

  assert.equal(audit.records.length, 1);
});
