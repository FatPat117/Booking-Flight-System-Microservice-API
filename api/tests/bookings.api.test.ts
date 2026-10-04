import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import request from "supertest";

import { createApp } from "../src/app.js";
import { createCancelBooking } from "../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createNoopOutboxRepository } from "../src/outbox/noop-outbox-repository.js";
import type { Logger } from "../src/observability/logger.js";
import {
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryHealthChecks,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";
const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");

function adminToken(): string {
  return jwt.sign(
    { sub: "admin-1", email: "admin@example.com", role: "admin" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function createMemoryLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createBookingApp() {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const auditRecorder = createInMemoryAuditRecorder();
  const transactionRunner = createInMemoryTransactionRunner();

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
    healthChecks: createInMemoryHealthChecks(),
    jwtSecret: TEST_JWT_SECRET,
  });
}

function createContext() {
  return { app: createBookingApp() };
}

test("POST booking returns 201 when seat is available", async () => {
  const { app } = createContext();

  const flightResponse = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${adminToken()}`)
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

test("POST booking returns 409 when flight is sold out", async () => {
  const { app } = createContext();

  const flightResponse = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${adminToken()}`)
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

test("POST booking returns 404 when flight does not exist", async () => {
  const { app } = createContext();

  const response = await request(app)
    .post("/api/flights/missing-flight/bookings")
    .send({ passengerName: "Alice" });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
});

test("POST booking returns 422 for invalid passenger name", async () => {
  const { app } = createContext();

  const flightResponse = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${adminToken()}`)
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

test("DELETE booking returns 204 then 409 on second cancel", async () => {
  const { app } = createContext();

  const flightResponse = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${adminToken()}`)
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

test("DELETE booking returns 404 when booking does not exist", async () => {
  const { app } = createContext();

  const response = await request(app).delete("/api/bookings/missing-booking");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "BOOKING_NOT_FOUND");
});
