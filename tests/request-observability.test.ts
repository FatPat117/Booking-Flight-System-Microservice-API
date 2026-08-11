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
import type { FlightRepository } from "../src/flights/flight-repository.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import { createHealthChecks } from "../src/health/health-checks.js";
import type { Logger, LogFields } from "../src/observability/logger.js";
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

type MemoryLogEntry = {
  level: "info" | "warn" | "error";
  message: string;
  fields?: LogFields;
};

function createMemoryLogger() {
  const entries: MemoryLogEntry[] = [];

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

  return {
    logger,
    entries,
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

  const { logger, entries } = createMemoryLogger();

  const app = createApp({
    flightRepository,
    createFlight,
    listFlights,
    logger,
    healthChecks: createHealthChecks(database),
    adminApiKey: TEST_ADMIN_API_KEY,
  });

  t.after(() => {
    database.close();
  });

  return {
    app,
    logs: entries,
  };
}

test("adds x-request-id when client does not provide one", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app).get("/health");

  assert.equal(response.status, 200);

  const requestId = response.headers["x-request-id"];
  assert.equal(typeof requestId, "string");
  assert.ok(typeof requestId === "string" && requestId.length > 0);
});

test("reuses client-provided x-request-id", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app)
    .get("/health")
    .set("x-request-id", "client-req-123");

  assert.equal(response.status, 200);
  assert.equal(response.headers["x-request-id"], "client-req-123");
});

test("logs request started and finished events", async (t) => {
  const { app, logs } = createTestContext(t);

  const response = await request(app).get("/api/flights");

  assert.equal(response.status, 200);

  const started = logs.find(
    (entry) => entry.message === "request_started",
  );
  const finished = logs.find(
    (entry) => entry.message === "request_finished",
  );

  assert.ok(started);
  assert.ok(finished);

  assert.equal(started.fields?.method, "GET");
  assert.equal(started.fields?.path, "/api/flights");
  assert.equal(finished.fields?.statusCode, 200);
  assert.equal(typeof finished.fields?.durationMs, "number");
  assert.ok(Number(finished.fields?.durationMs) >= 0);

  assert.equal(
    started.fields?.requestId,
    response.headers["x-request-id"],
  );
  assert.equal(
    finished.fields?.requestId,
    response.headers["x-request-id"],
  );
});

test("logs unexpected errors with request id without leaking them to client", async () => {
  const failingRepository: FlightRepository = {
    findPage() {
      throw new Error("sensitive database failure");
    },
    findById() {
      return undefined;
    },
    create() {
      return {
        outcome: "created",
      };
    },
  };

  const createFlight = createCreateFlight({
    flightRepository: failingRepository,
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
    flightRepository: failingRepository,
  });

  const { logger, entries } = createMemoryLogger();

  const app = createApp({
    flightRepository: failingRepository,
    createFlight,
    listFlights,
    logger,
    healthChecks: {
      checkReadiness() {
        return {
          status: "ok",
          checks: {
            database: {
              status: "ok",
            },
          },
        };
      },
    },
    adminApiKey: TEST_ADMIN_API_KEY,
  });

  const response = await request(app)
    .get("/api/flights")
    .set("x-request-id", "req-error-1");

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "INTERNAL_SERVER_ERROR");
  assert.ok(
    !JSON.stringify(response.body).includes("sensitive database failure"),
  );

  const errorLog = entries.find(
    (entry) =>
      entry.level === "error" && entry.message === "unexpected_error",
  );

  assert.ok(errorLog);
  assert.equal(errorLog.fields?.requestId, "req-error-1");
  assert.equal(
    errorLog.fields?.errorMessage,
    "sensitive database failure",
  );
});
