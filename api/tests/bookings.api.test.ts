import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

import type { AircraftRepository } from "../src/aircraft/aircraft-repository.js";
import { createApp } from "../src/app.js";
import { createCancelBooking } from "../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { createGetBooking } from "../src/bookings/get-booking.js";
import { createListBookings } from "../src/bookings/list-bookings.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createGetFlight } from "../src/flights/get-flight.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createOpenFlight } from "../src/flights/open-flight.js";
import { createNoopOutboxRepository } from "../src/outbox/noop-outbox-repository.js";
import type { Logger } from "../src/observability/logger.js";
import { makeSeats, TEST_AIRPORTS } from "./fixtures/flights.js";
import {
  createInMemoryAircraftRepository,
  createInMemoryAirportRepository,
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryHealthChecks,
  createInMemoryTransactionRunner,
  createUnusedReferenceData,
  type InMemoryAuditRecorder,
} from "./fakes/in-memory.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";
const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const UNKNOWN_BOOKING_ID = "c0ffee00-0000-4000-8000-000000000000";

function token(sub: string, role: "user" | "admin"): string {
  return jwt.sign(
    { sub, email: `${role}-${sub.slice(0, 4)}@example.com`, role },
    TEST_JWT_SECRET,
    { expiresIn: "1h" },
  );
}

const USER_A = token(ACCOUNT_A, "user");
const USER_B = token(ACCOUNT_B, "user");
const ADMIN = token(ADMIN_ACCOUNT, "admin");

function createMemoryLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

/** Per-app access to the aircraft fake seedFlight registers aircraft in. */
const seedAccess = new WeakMap<Express, AircraftRepository>();

function createContext(): { app: Express; audit: InMemoryAuditRecorder } {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const airportRepository = createInMemoryAirportRepository(TEST_AIRPORTS);
  const aircraftRepository = createInMemoryAircraftRepository();
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const audit = createInMemoryAuditRecorder();
  const transactionRunner = createInMemoryTransactionRunner();
  const common = {
    auditRecorder: audit,
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  };

  const app = createApp({
    getFlight: createGetFlight({ flightRepository, getCurrentTime: () => FIXED_TIME }),
    createFlight: createCreateFlight({
      ...common,
      flightRepository,
      airportRepository,
      aircraftRepository,
      generateId: () => crypto.randomUUID(),
    }),
    openFlight: createOpenFlight({ ...common, flightRepository }),
    createBooking: createCreateBooking({
      ...common,
      bookingRepository,
      generateId: () => crypto.randomUUID(),
    }),
    cancelBooking: createCancelBooking({ ...common, bookingRepository }),
    getBooking: createGetBooking({ bookingRepository }),
    listBookings: createListBookings({ bookingRepository }),
    listFlights: createListFlights({ flightRepository, getCurrentTime: () => FIXED_TIME }),
    ...createUnusedReferenceData(),
    logger: createMemoryLogger(),
    healthChecks: createInMemoryHealthChecks(),
    jwtSecret: TEST_JWT_SECRET,
  });

  seedAccess.set(app, aircraftRepository);
  return { app, audit };
}

let flightSequence = 0;

/**
 * A flight with `seats` seats: registers an aircraft of that size (capacity
 * comes from the aircraft since Day 46), creates the flight through the API,
 * then opens it for sale through the API unless `open` is false.
 */
async function seedFlight(
  app: Express,
  seats = 5,
  { open = true }: { open?: boolean } = {},
): Promise<string> {
  flightSequence += 1;
  const aircraftRepository = seedAccess.get(app);
  assert.ok(aircraftRepository);

  const registration = `VN-B${String(flightSequence).padStart(3, "0")}`;
  await aircraftRepository.create({
    id: crypto.randomUUID(),
    registration,
    model: "Airbus A321",
    createdAt: FIXED_TIME.toISOString(),
    seats: makeSeats(seats),
  });

  const response = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${ADMIN}`)
    .send({
      flightNumber: `VN${100 + flightSequence}`,
      origin: "SGN",
      destination: "HAN",
      aircraftRegistration: registration,
      departureAt: "2026-12-10T08:00:00+07:00",
      arrivalAt: "2026-12-10T10:00:00+07:00",
      priceInCents: 1_500_000,
      currency: "VND",
    });

  assert.equal(response.status, 201);
  const flightId = response.body.id as string;

  if (open) {
    const opened = await request(app)
      .post(`/api/flights/${flightId}/open`)
      .set("Authorization", `Bearer ${ADMIN}`);
    assert.equal(opened.status, 200);
  }

  return flightId;
}

function book(app: Express, accessToken: string, flightId: string, passengerName = "Alice") {
  return request(app)
    .post(`/api/flights/${flightId}/bookings`)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ passengerName });
}

async function seedBooking(app: Express, accessToken: string): Promise<string> {
  const flightId = await seedFlight(app);
  const response = await book(app, accessToken, flightId);
  assert.equal(response.status, 201);
  return response.body.id as string;
}

function as(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

// ---------------------------------------------------------------------------
// Creating a booking
// ---------------------------------------------------------------------------

test("POST booking returns 201 owned by the caller, with a Location that GET resolves", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 2);

  const created = await book(app, USER_A, flightId, "Alice Nguyen");

  assert.equal(created.status, 201);
  assert.equal(created.body.flightId, flightId);
  assert.equal(created.body.ownerAccountId, ACCOUNT_A);
  assert.equal(created.body.passengerName, "Alice Nguyen");
  assert.equal(created.headers.location, `/api/bookings/${created.body.id}`);

  const fetched = await request(app).get(created.headers.location ?? "").set(as(USER_A));
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body, created.body);
});

test("POST booking returns 409 when flight is sold out", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 1);

  assert.equal((await book(app, USER_A, flightId)).status, 201);
  const second = await book(app, USER_B, flightId, "Bob");

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "FLIGHT_SOLD_OUT");
});

test("POST booking on a flight not yet opened for sale is 409 SALES_CLOSED, and no seat is taken", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 2, { open: false });

  const response = await book(app, USER_A, flightId);

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "SALES_CLOSED");
  const flight = await request(app).get(`/api/flights/${flightId}`);
  assert.equal(flight.body.status, "SCHEDULED");
  assert.equal(flight.body.availableSeats, 2);
});

test("POST booking returns 404 for an unknown or malformed flight id", async () => {
  const { app } = createContext();

  const unknown = await book(app, USER_A, UNKNOWN_BOOKING_ID);
  const malformed = await book(app, USER_A, "missing-flight");

  for (const response of [unknown, malformed]) {
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
  }
});

test("POST booking returns 422 for invalid passenger name", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app);

  const response = await book(app, USER_A, flightId, "  ");

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("an admin cannot book on someone's behalf: 403 (BR-AUTH-03)", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app);

  const response = await book(app, ADMIN, flightId);

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test("every booking endpoint returns 401 without a token", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app);
  const bookingId = await seedBooking(app, USER_A);

  const responses = await Promise.all([
    request(app).post(`/api/flights/${flightId}/bookings`).send({ passengerName: "Alice" }),
    request(app).get("/api/bookings"),
    request(app).get(`/api/bookings/${bookingId}`),
    request(app).delete(`/api/bookings/${bookingId}`),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "MISSING_TOKEN");
  }
});

// ---------------------------------------------------------------------------
// Object-level authorization (BOLA)
// ---------------------------------------------------------------------------

test("another account's booking answers GET exactly like a missing one: 404 with the same body", async () => {
  const { app } = createContext();
  const bookingOfA = await seedBooking(app, USER_A);

  const otherAccount = await request(app).get(`/api/bookings/${bookingOfA}`).set(as(USER_B));
  const missing = await request(app).get(`/api/bookings/${UNKNOWN_BOOKING_ID}`).set(as(USER_B));

  assert.equal(otherAccount.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(otherAccount.body, missing.body);
  assert.equal(otherAccount.body.error.code, "BOOKING_NOT_FOUND");
});

test("another account cannot cancel the booking: 404, and the owner still sees it active", async () => {
  const { app } = createContext();
  const bookingOfA = await seedBooking(app, USER_A);

  const attempt = await request(app).delete(`/api/bookings/${bookingOfA}`).set(as(USER_B));
  const missing = await request(app).delete(`/api/bookings/${UNKNOWN_BOOKING_ID}`).set(as(USER_B));

  assert.equal(attempt.status, 404);
  assert.deepEqual(attempt.body, missing.body);

  const stillThere = await request(app).get(`/api/bookings/${bookingOfA}`).set(as(USER_A));
  assert.equal(stillThere.body.status, "active");
});

test("cancelling another account's already-cancelled booking is still 404, never 409", async () => {
  const { app } = createContext();
  const bookingOfA = await seedBooking(app, USER_A);
  assert.equal((await request(app).delete(`/api/bookings/${bookingOfA}`).set(as(USER_A))).status, 204);

  const attempt = await request(app).delete(`/api/bookings/${bookingOfA}`).set(as(USER_B));

  assert.equal(attempt.status, 404);
  assert.equal(attempt.body.error.code, "BOOKING_NOT_FOUND");
});

test("GET /api/bookings lists only the caller's bookings; an admin lists everyone's", async () => {
  const { app } = createContext();
  const bookingOfA = await seedBooking(app, USER_A);
  const bookingOfB = await seedBooking(app, USER_B);

  const listOfA = await request(app).get("/api/bookings").set(as(USER_A));
  const listOfAdmin = await request(app).get("/api/bookings").set(as(ADMIN));

  assert.equal(listOfA.status, 200);
  assert.deepEqual(
    listOfA.body.items.map((booking: { id: string }) => booking.id),
    [bookingOfA],
  );
  assert.equal(listOfA.body.pagination.totalItems, 1);
  assert.deepEqual(
    new Set(listOfAdmin.body.items.map((booking: { id: string }) => booking.id)),
    new Set([bookingOfA, bookingOfB]),
  );
});

test("GET /api/bookings rejects invalid pagination with 422", async () => {
  const { app } = createContext();

  const response = await request(app).get("/api/bookings?page=0").set(as(USER_A));

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("an admin can read any booking but cannot cancel it: 403", async () => {
  const { app } = createContext();
  const bookingOfA = await seedBooking(app, USER_A);

  const read = await request(app).get(`/api/bookings/${bookingOfA}`).set(as(ADMIN));
  const cancel = await request(app).delete(`/api/bookings/${bookingOfA}`).set(as(ADMIN));

  assert.equal(read.status, 200);
  assert.equal(read.body.ownerAccountId, ACCOUNT_A);
  assert.equal(cancel.status, 403);
});

test("a malformed booking id is 404 on GET and DELETE, not 500", async () => {
  const { app } = createContext();

  const read = await request(app).get("/api/bookings/missing-booking").set(as(USER_A));
  const cancel = await request(app).delete("/api/bookings/missing-booking").set(as(USER_A));

  for (const response of [read, cancel]) {
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "BOOKING_NOT_FOUND");
  }
});

// ---------------------------------------------------------------------------
// Cancelling and audit
// ---------------------------------------------------------------------------

test("DELETE booking returns 204 then 409 on the owner's second cancel, and releases the seat once", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 3);
  const created = await book(app, USER_A, flightId);
  const bookingId = created.body.id as string;

  const first = await request(app).delete(`/api/bookings/${bookingId}`).set(as(USER_A));
  const second = await request(app).delete(`/api/bookings/${bookingId}`).set(as(USER_A));

  assert.equal(first.status, 204);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "BOOKING_ALREADY_CANCELLED");

  const flightAfter = await request(app).get(`/api/flights/${flightId}`);
  assert.equal(flightAfter.body.availableSeats, 3);
});

test("audit records the acting accounts: admin for creating and opening the flight, the owner for create and cancel", async () => {
  const { app, audit } = createContext();
  const bookingId = await seedBooking(app, USER_A);
  await request(app).delete(`/api/bookings/${bookingId}`).set(as(USER_A));

  const actorsByAction = Object.fromEntries(
    audit.records.map((record) => [record.action, record.actor]),
  );

  assert.deepEqual(actorsByAction, {
    FLIGHT_CREATED: { type: "account", id: ADMIN_ACCOUNT },
    FLIGHT_OPENED: { type: "account", id: ADMIN_ACCOUNT },
    BOOKING_CREATED: { type: "account", id: ACCOUNT_A },
    BOOKING_CANCELLED: { type: "account", id: ACCOUNT_A },
  });
});
