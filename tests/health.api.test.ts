import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import request from "supertest";

import { createApp } from "../src/app.js";
import type { AuditRecorder } from "../src/audit/audit-recorder.js";
import { openDatabase } from "../src/database.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createNoopOutboxRepository } from "../src/outbox/noop-outbox-repository.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import type { HealthChecks } from "../src/health/health-checks.js";
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

function createMemoryLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createTestContext(t: TestContext) {
  const database = openDatabase(":memory:");

  const flightRepository = createSqliteFlightRepository(database);

  const createFlight = createCreateFlight({
    flightRepository,
    auditRecorder: createNoopAuditRecorder(),
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
  });

  const listFlights = createListFlights({
    flightRepository,
  });

  const healthChecks = createHealthChecks(database);

  const app = createApp({
    flightRepository,
    createFlight,
    listFlights,
    logger: createMemoryLogger(),
    healthChecks,
    adminApiKey: TEST_ADMIN_API_KEY,
  });

  t.after(() => {
    database.close();
  });

  return {
    app,
    database,
  };
}

test("GET /live returns liveness status", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app).get("/live");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: "ok",
  });
  assert.equal(typeof response.headers["x-request-id"], "string");
});

test("GET /health remains a liveness alias", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: "ok",
  });
});

test("GET /ready returns ok when database is available", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app).get("/ready");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: "ok",
    checks: {
      database: {
        status: "ok",
      },
    },
  });
});

test("GET /ready returns 503 when database is unavailable", async (t) => {
  const database = openDatabase(":memory:");

  const flightRepository = createSqliteFlightRepository(database);

  const createFlight = createCreateFlight({
    flightRepository,
    auditRecorder: createNoopAuditRecorder(),
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
  });

  const listFlights = createListFlights({
    flightRepository,
  });

  const unhealthyHealthChecks: HealthChecks = {
    checkReadiness() {
      return {
        status: "unavailable",
        checks: {
          database: {
            status: "unavailable",
          },
        },
      };
    },
  };

  const app = createApp({
    flightRepository,
    createFlight,
    listFlights,
    logger: createMemoryLogger(),
    healthChecks: unhealthyHealthChecks,
    adminApiKey: TEST_ADMIN_API_KEY,
  });

  t.after(() => {
    database.close();
  });

  const response = await request(app).get("/ready");

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    status: "unavailable",
    checks: {
      database: {
        status: "unavailable",
      },
    },
  });
});
