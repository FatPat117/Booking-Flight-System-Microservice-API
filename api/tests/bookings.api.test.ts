import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import request from "supertest";

import { createApp } from "../src/app.js";
import { createCancelBooking } from "../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { createSqliteBookingRepository } from "../src/bookings/sqlite-booking-repository.js";
import { createSqliteAuditRecorder } from "../src/audit/sqlite-audit-recorder.js";
import { openDatabase } from "../src/database.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createHealthChecks } from "../src/health/health-checks.js";
import { createNoopOutboxRepository } from "../src/outbox/noop-outbox-repository.js";
import type { Logger } from "../src/observability/logger.js";
import { createSqliteTransactionRunner } from "../src/transactions/sqlite-transaction-runner.js";

const TEST_ADMIN_API_KEY = "test-admin-key-123456";
const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");

function createMemoryLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createBookingApp(database: DatabaseSync) {
  const flightRepository = createSqliteFlightRepository(database);
  const bookingRepository = createSqliteBookingRepository(database);
  const auditRecorder = createSqliteAuditRecorder(database);
  const transactionRunner = createSqliteTransactionRunner(database);

  const createFlight = createCreateFlight({
    flightRepository,
    auditRecorder,
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  return createApp({
    flightRepository,
    createFlight,
    createBooking,
    cancelBooking,
    listFlights: createListFlights({ flightRepository }),
    logger: createMemoryLogger(),
    healthChecks: createHealthChecks(database),
    adminApiKey: TEST_ADMIN_API_KEY,
    jwtSecret: "test-jwt-secret-at-least-32-chars!!",
  });
}

function createContext(t: TestContext) {
  const database = openDatabase(":memory:");
  const app = createBookingApp(database);

  t.after(() => {
    database.close();
  });

  return { app, database };
}

test("POST booking returns 201 when seat is available", async (t) => {
  const { app } = createContext(t);

  const flightResponse = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${TEST_ADMIN_API_KEY}`)
    .send({
      flightNumber: "VN888",
      origin: "SGN",
      destination: "HAN",
      departureAt: "2026-12-10T08:00:00+07:00",
      arrivalAt: "2026-12-10T10:00:00+07:00",
      priceInCents: 1_500_000,
      currency: "VND",
      availableSeats: 2,
    });

  assert.equal(flightResponse.status, 201);
  const flightId = flightResponse.body.id as string;

  const bookingResponse = await request(app)
    .post(`/api/flights/${flightId}/bookings`)
    .send({ passengerName: "Alice Nguyen" });

  assert.equal(bookingResponse.status, 201);
  assert.equal(bookingResponse.body.flightId, flightId);
  assert.equal(bookingResponse.body.passengerName, "Alice Nguyen");
  assert.match(bookingResponse.headers.location ?? "", new RegExp(flightId));
});

test("POST booking returns 409 when flight is sold out", async (t) => {
  const { app } = createContext(t);

  const flightResponse = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${TEST_ADMIN_API_KEY}`)
    .send({
      flightNumber: "VN777",
      origin: "SGN",
      destination: "HAN",
      departureAt: "2026-12-11T08:00:00+07:00",
      arrivalAt: "2026-12-11T10:00:00+07:00",
      priceInCents: 1_500_000,
      currency: "VND",
      availableSeats: 1,
    });

  const flightId = flightResponse.body.id as string;

  const first = await request(app)
    .post(`/api/flights/${flightId}/bookings`)
    .send({ passengerName: "Alice" });
  assert.equal(first.status, 201);

  const second = await request(app)
    .post(`/api/flights/${flightId}/bookings`)
    .send({ passengerName: "Bob" });

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "FLIGHT_SOLD_OUT");
});

test("POST booking returns 404 when flight does not exist", async (t) => {
  const { app } = createContext(t);

  const response = await request(app)
    .post("/api/flights/missing-flight/bookings")
    .send({ passengerName: "Alice" });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
});

test("POST booking returns 422 for invalid passenger name", async (t) => {
  const { app } = createContext(t);

  const flightResponse = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${TEST_ADMIN_API_KEY}`)
    .send({
      flightNumber: "VN666",
      origin: "SGN",
      destination: "HAN",
      departureAt: "2026-12-12T08:00:00+07:00",
      arrivalAt: "2026-12-12T10:00:00+07:00",
      priceInCents: 1_500_000,
      currency: "VND",
      availableSeats: 1,
    });

  const flightId = flightResponse.body.id as string;

  const response = await request(app)
    .post(`/api/flights/${flightId}/bookings`)
    .send({ passengerName: "  " });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("DELETE booking returns 204 then 409 on second cancel", async (t) => {
  const { app } = createContext(t);

  const flightResponse = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${TEST_ADMIN_API_KEY}`)
    .send({
      flightNumber: "VN555",
      origin: "SGN",
      destination: "HAN",
      departureAt: "2026-12-13T08:00:00+07:00",
      arrivalAt: "2026-12-13T10:00:00+07:00",
      priceInCents: 1_500_000,
      currency: "VND",
      availableSeats: 3,
    });

  const flightId = flightResponse.body.id as string;

  const bookingResponse = await request(app)
    .post(`/api/flights/${flightId}/bookings`)
    .send({ passengerName: "Alice" });

  assert.equal(bookingResponse.status, 201);
  const bookingId = bookingResponse.body.id as string;

  const first = await request(app).delete(`/api/bookings/${bookingId}`);
  assert.equal(first.status, 204);

  const second = await request(app).delete(`/api/bookings/${bookingId}`);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "BOOKING_ALREADY_CANCELLED");

  const flightAfter = await request(app).get(`/api/flights/${flightId}`);
  assert.equal(flightAfter.body.availableSeats, 3);
});

test("DELETE booking returns 404 when booking does not exist", async (t) => {
  const { app } = createContext(t);

  const response = await request(app).delete("/api/bookings/missing-booking");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "BOOKING_NOT_FOUND");
});
