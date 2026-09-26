import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

import { createApp } from "../src/app.js";
import { createVerifyJwtMiddleware } from "../src/auth/verify-jwt.js";
import type { AuditRecorder } from "../src/audit/audit-recorder.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { createSqliteBookingRepository } from "../src/bookings/sqlite-booking-repository.js";
import { openDatabase } from "../src/database.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import { createHealthChecks } from "../src/health/health-checks.js";
import type { Logger } from "../src/observability/logger.js";
import {
  getAuthenticatedUser,
  runWithRequestContext,
} from "../src/observability/request-context.js";
import { createNoopOutboxRepository } from "../src/outbox/noop-outbox-repository.js";
import type { TransactionRunner } from "../src/transactions/transaction-runner.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";

type MockResponseState = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
};

function createMockResponse(): {
  response: Response;
  state: MockResponseState;
} {
  const state: MockResponseState = {
    statusCode: 0,
    body: undefined,
    headers: {},
  };

  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return response;
    },
  };

  return { response: response as unknown as Response, state };
}

function createMockRequest(
  authorization: string | undefined,
): Request {
  return {
    headers: {
      ...(authorization === undefined
        ? {}
        : { authorization }),
    },
  } as Request;
}

test("verifyJwt rejects missing Authorization header", () => {
  const middleware = createVerifyJwtMiddleware({
    jwtSecret: TEST_JWT_SECRET,
  });
  const { response, state } = createMockResponse();
  let nextCalled = false;

  runWithRequestContext({ requestId: "req-1" }, () => {
    middleware(
      createMockRequest(undefined),
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.equal(
    (state.body as { error: { code: string } }).error.code,
    "MISSING_TOKEN",
  );
});

test("verifyJwt accepts a valid token and sets authenticatedUser", () => {
  const middleware = createVerifyJwtMiddleware({
    jwtSecret: TEST_JWT_SECRET,
  });
  const token = jwt.sign(
    { sub: "user-1", email: "alice@example.com", role: "admin" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" },
  );
  const { response, state } = createMockResponse();
  let nextCalled = false;
  let userAfterNext: ReturnType<typeof getAuthenticatedUser>;

  runWithRequestContext({ requestId: "req-1" }, () => {
    middleware(
      createMockRequest(`Bearer ${token}`),
      response,
      (() => {
        nextCalled = true;
        userAfterNext = getAuthenticatedUser();
      }) as NextFunction,
    );
  });

  assert.equal(nextCalled, true);
  assert.equal(state.statusCode, 0);
  assert.deepEqual(userAfterNext, {
    userId: "user-1",
    email: "alice@example.com",
    role: "admin",
  });
});

test("verifyJwt rejects a token without role claim", () => {
  const middleware = createVerifyJwtMiddleware({
    jwtSecret: TEST_JWT_SECRET,
  });
  const token = jwt.sign(
    { sub: "user-1", email: "alice@example.com" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" },
  );
  const { response, state } = createMockResponse();
  let nextCalled = false;

  runWithRequestContext({ requestId: "req-1" }, () => {
    middleware(
      createMockRequest(`Bearer ${token}`),
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.equal(
    (state.body as { error: { code: string } }).error.code,
    "INVALID_TOKEN",
  );
});

test("verifyJwt rejects an expired token", () => {
  const middleware = createVerifyJwtMiddleware({
    jwtSecret: TEST_JWT_SECRET,
  });
  const token = jwt.sign(
    { sub: "user-1", email: "alice@example.com", role: "user" },
    TEST_JWT_SECRET,
    { expiresIn: "-1s" },
  );
  const { response, state } = createMockResponse();
  let nextCalled = false;

  runWithRequestContext({ requestId: "req-1" }, () => {
    middleware(
      createMockRequest(`Bearer ${token}`),
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.equal(
    (state.body as { error: { code: string } }).error.code,
    "TOKEN_EXPIRED",
  );
});

test("verifyJwt rejects a tampered token", () => {
  const middleware = createVerifyJwtMiddleware({
    jwtSecret: TEST_JWT_SECRET,
  });
  const token = jwt.sign(
    { sub: "user-1", email: "alice@example.com", role: "user" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" },
  );
  const tampered = `${token.slice(0, -4)}xxxx`;
  const { response, state } = createMockResponse();
  let nextCalled = false;

  runWithRequestContext({ requestId: "req-1" }, () => {
    middleware(
      createMockRequest(`Bearer ${tampered}`),
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.equal(
    (state.body as { error: { code: string } }).error.code,
    "INVALID_TOKEN",
  );
});

function createNoopAuditRecorder(): AuditRecorder {
  return { record() {} };
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

test("GET /api/whoami returns user from a valid JWT", async () => {
  const database = openDatabase(":memory:");
  const flightRepository = createSqliteFlightRepository(database);
  const bookingRepository = createSqliteBookingRepository(database);

  const app = createApp({
    flightRepository,
    createFlight: createCreateFlight({
      flightRepository,
      auditRecorder: createNoopAuditRecorder(),
      outboxRepository: createNoopOutboxRepository(),
      transactionRunner: createPassthroughTransactionRunner(),
      generateId: () => "fixed-flight-id",
      generateAuditId: () => "fixed-audit-id",
      generateOutboxId: () => "fixed-outbox-id",
      getRequestId: () => "fixed-request-id",
      getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
    }),
    createBooking: createCreateBooking({
      bookingRepository,
      auditRecorder: createNoopAuditRecorder(),
      outboxRepository: createNoopOutboxRepository(),
      transactionRunner: createPassthroughTransactionRunner(),
      generateId: () => "fixed-booking-id",
      generateAuditId: () => "fixed-audit-id",
      generateOutboxId: () => "fixed-outbox-id",
      getRequestId: () => "fixed-request-id",
      getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
    }),
    cancelBooking: async () => ({ outcome: "not-found" as const }),
    listFlights: createListFlights({ flightRepository }),
    logger: createMemoryLogger(),
    healthChecks: createHealthChecks(database),
    jwtSecret: TEST_JWT_SECRET,
  });

  const token = jwt.sign(
    { sub: "user-whoami", email: "whoami@example.com", role: "user" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" },
  );

  const response = await request(app)
    .get("/api/whoami")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    userId: "user-whoami",
    email: "whoami@example.com",
    role: "user",
  });

  database.close();
});

test("GET /api/whoami returns 401 without a token", async () => {
  const database = openDatabase(":memory:");
  const flightRepository = createSqliteFlightRepository(database);

  const app = createApp({
    flightRepository,
    createFlight: createCreateFlight({
      flightRepository,
      auditRecorder: createNoopAuditRecorder(),
      outboxRepository: createNoopOutboxRepository(),
      transactionRunner: createPassthroughTransactionRunner(),
      generateId: () => "fixed-flight-id",
      generateAuditId: () => "fixed-audit-id",
      generateOutboxId: () => "fixed-outbox-id",
      getRequestId: () => "fixed-request-id",
      getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
    }),
    createBooking: async () => ({ outcome: "flight-not-found" as const }),
    cancelBooking: async () => ({ outcome: "not-found" as const }),
    listFlights: createListFlights({ flightRepository }),
    logger: createMemoryLogger(),
    healthChecks: createHealthChecks(database),
    jwtSecret: TEST_JWT_SECRET,
  });

  const response = await request(app).get("/api/whoami");

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "MISSING_TOKEN");

  database.close();
});
