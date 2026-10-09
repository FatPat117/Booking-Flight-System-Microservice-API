import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

import { createApp } from "../src/app.js";
import type { AuditRecorder } from "../src/audit/audit-recorder.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createNoopOutboxRepository } from "../src/outbox/noop-outbox-repository.js";
import { createListFlights } from "../src/flights/list-flights.js";
import type { BookingRepository } from "../src/bookings/booking-repository.js";
import type { HealthChecks } from "../src/health/health-checks.js";
import type { Logger } from "../src/observability/logger.js";
import type { TransactionRunner } from "../src/transactions/transaction-runner.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryHealthChecks,
  createUnusedBookingReads,
} from "./fakes/in-memory.js";


function createNoopAuditRecorder(): AuditRecorder {
  return {
    async record() {},
  };
}

function createPassthroughTransactionRunner(): TransactionRunner {
  return {
    async run(operation) {
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

function createTestCreateBooking(
  bookingRepository: BookingRepository,
) {
  return createCreateBooking({
    bookingRepository,
    auditRecorder: createNoopAuditRecorder(),
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => "fixed-booking-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
  });
}

function createTestContext() {
  const flights = createInMemoryFlightStore();

  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });

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

  const healthChecks = createInMemoryHealthChecks();

  const app = createApp({
    flightRepository,
    createFlight,
    createBooking: createTestCreateBooking(bookingRepository),
    cancelBooking: async () => ({ outcome: "not-found" as const }),
    ...createUnusedBookingReads(),
    listFlights,
    logger: createMemoryLogger(),
    healthChecks,
    jwtSecret: "test-jwt-secret-at-least-32-chars!!",
  });

  return {
    app,
  };
}

test("GET /live returns liveness status", async () => {
  const { app } = createTestContext();

  const response = await request(app).get("/live");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: "ok",
  });
  assert.equal(typeof response.headers["x-request-id"], "string");
});

test("GET /health remains a liveness alias", async () => {
  const { app } = createTestContext();

  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: "ok",
  });
});

test("GET /ready returns ok when database is available", async () => {
  const { app } = createTestContext();

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

test("GET /ready returns 503 when database is unavailable", async () => {
  const flights = createInMemoryFlightStore();

  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });

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
    async checkReadiness() {
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
    createBooking: createTestCreateBooking(bookingRepository),
    cancelBooking: async () => ({ outcome: "not-found" as const }),
    ...createUnusedBookingReads(),
    listFlights,
    logger: createMemoryLogger(),
    healthChecks: unhealthyHealthChecks,
    jwtSecret: "test-jwt-secret-at-least-32-chars!!",
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
