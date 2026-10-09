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
import { createListFlights } from "../src/flights/list-flights.js";
import type { HealthChecks } from "../src/health/health-checks.js";
import type { Logger, LogFields } from "../src/observability/logger.js";
import { getRequestContext } from "../src/observability/request-context.js";
import {
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
  createUnusedBookingReads,
  type InMemoryAuditRecorder,
  type InMemoryFlightStore,
} from "./fakes/in-memory.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";

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
  availableSeats: number;
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
    availableSeats: 120,
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
    auditRecorder,
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
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
    getCurrentTime: () => new Date(),
  });

  const listFlights = createListFlights({
    flightRepository,
  });

  const { logger } = createMemoryLogger();

  return createApp({
    flightRepository,
    createFlight,
    createBooking,
    cancelBooking: async () => ({ outcome: "not-found" as const }),
    ...createUnusedBookingReads(),
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
  const response = await request(app).get("/api/flights/not-found-id");

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
  assert.equal(response.body.flight_number, undefined);

  const getResponse = await request(app).get(
    `/api/flights/${response.body.id}`,
  );
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.id, response.body.id);
  assert.equal(getResponse.body.flightNumber, "VN123");
});

test("POST /api/flights accepts availableSeats = 0", async () => {
  const { app } = createTestContext();

  const response = await postFlight(app)
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
      name: "negative seats",
      override: { availableSeats: -1 },
      code: "INVALID_AVAILABLE_SEATS",
      field: "availableSeats",
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
