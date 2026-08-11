import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import request from "supertest";

import { createApp } from "../src/app.js";
import type { AuditRecorder } from "../src/audit/audit-recorder.js";
import { openDatabase } from "../src/database.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createNoopMessagePublisher } from "../src/messaging/noop-message-publisher.js";
import { createConsoleLogger } from "../src/observability/logger.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import { createHealthChecks } from "../src/health/health-checks.js";
import type { Logger } from "../src/observability/logger.js";
import type { TransactionRunner } from "../src/transactions/transaction-runner.js";

const TEST_ADMIN_API_KEY = "test-admin-key-123456";

function createNoopAuditRecorder(): AuditRecorder {
  return {
    record() {},
  };
}

function createPassthroughTransactionRunner(): TransactionRunner {
  return {
    run(operation) {
      return operation();
    },
  };
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
};

function createMemoryLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
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

function createTestContext(t: TestContext) {
  const database = openDatabase(":memory:");
  const flightRepository = createSqliteFlightRepository(database);

  const createFlight = createCreateFlight({
    flightRepository,
    auditRecorder: createNoopAuditRecorder(),
    transactionRunner: createPassthroughTransactionRunner(),
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
  });

  const listFlights = createListFlights({
    flightRepository,
  });

  const app = createApp({
    flightRepository,
    createFlight,
    listFlights,
    logger: createMemoryLogger(),
    healthChecks: createHealthChecks(database),
    adminApiKey: TEST_ADMIN_API_KEY,
  });

  t.after(() => {
    database.close();
  });

  return { app };
}

test("POST /api/flights rejects missing authentication", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app)
    .post("/api/flights")
    .send(makeValidFlight());

  assert.equal(response.status, 401);
  assert.equal(response.headers["www-authenticate"], "Bearer");
  assert.deepEqual(response.body, {
    error: {
      code: "UNAUTHENTICATED",
      message: "Authentication is required",
    },
  });
});

test("POST /api/flights rejects invalid authentication", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app)
    .post("/api/flights")
    .set("Authorization", "Bearer wrong-api-key")
    .send(makeValidFlight());

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHENTICATED");
});

test("POST /api/flights rejects unsupported authentication scheme", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app)
    .post("/api/flights")
    .set("Authorization", `Basic ${TEST_ADMIN_API_KEY}`)
    .send(makeValidFlight());

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHENTICATED");
});

test("POST /api/flights accepts valid admin API key", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${TEST_ADMIN_API_KEY}`)
    .send(makeValidFlight());

  assert.equal(response.status, 201);
  assert.equal(typeof response.body.id, "string");
});

test("GET /api/flights remains public", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app).get("/api/flights");

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
});

test("GET /ready remains public", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app).get("/ready");

  assert.equal(response.status, 200);
});

test("unauthenticated create request does not create a flight", async (t) => {
  const { app } = createTestContext(t);

  const createResponse = await request(app)
    .post("/api/flights")
    .send(makeValidFlight());

  assert.equal(createResponse.status, 401);

  const listResponse = await request(app).get("/api/flights");

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.pagination.totalItems, 0);
});
