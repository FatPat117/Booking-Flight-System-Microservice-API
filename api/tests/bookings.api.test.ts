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
import { createGetBookingByReference } from "../src/bookings/get-booking-by-reference.js";
import { createListBookings } from "../src/bookings/list-bookings.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import { createGetFlight } from "../src/flights/get-flight.js";
import { createGetFlightSeatMap } from "../src/flights/get-flight-seat-map.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createOpenFlight } from "../src/flights/open-flight.js";
import { createNoopOutboxRepository } from "../src/outbox/noop-outbox-repository.js";
import type { Logger } from "../src/observability/logger.js";
import { nextBookingReference } from "./fixtures/bookings.js";
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
    getFlightSeatMap: createGetFlightSeatMap({ flightRepository }),
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
      generateReference: nextBookingReference,
    }),
    cancelBooking: createCancelBooking({ ...common, bookingRepository }),
    getBooking: createGetBooking({ bookingRepository }),
    getBookingByReference: createGetBookingByReference({ bookingRepository }),
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

type PassengerBody = { name: string; seat?: string };

function book(
  app: Express,
  accessToken: string,
  flightId: string,
  passengers: PassengerBody[] = [{ name: "Alice" }],
) {
  return request(app)
    .post(`/api/flights/${flightId}/bookings`)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ passengers });
}

/** Seat code → status, from the public seat map. */
async function seatStatuses(app: Express, flightId: string) {
  const response = await request(app).get(`/api/flights/${flightId}/seats`);
  assert.equal(response.status, 200);
  const statuses: Record<string, string> = {};
  for (const row of response.body.rows as Array<{ seats: Array<{ code: string; status: string }> }>) {
    for (const seat of row.seats) {
      statuses[seat.code] = seat.status;
    }
  }
  return statuses;
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

  const created = await book(app, USER_A, flightId, [{ name: "Alice Nguyen" }]);

  assert.equal(created.status, 201);
  assert.equal(created.body.flightId, flightId);
  assert.equal(created.body.ownerAccountId, ACCOUNT_A);
  assert.deepEqual(created.body.passengers, [{ name: "Alice Nguyen", seat: "1A" }]);
  assert.equal(created.body.status, "HELD");
  // BR-BOOK-04: fifteen minutes after FIXED_TIME.
  assert.equal(created.body.holdExpiresAt, "2026-07-20T00:15:00.000Z");
  assert.match(created.body.reference, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.headers.location, `/api/bookings/${created.body.id}`);

  const fetched = await request(app).get(created.headers.location ?? "").set(as(USER_A));
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body, created.body);
});

test("POST booking returns 409 NOT_ENOUGH_SEATS when the flight has no seat left", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 1);

  assert.equal((await book(app, USER_A, flightId)).status, 201);
  const second = await book(app, USER_B, flightId, [{ name: "Bob" }]);

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "NOT_ENOUGH_SEATS");
});

test("POST booking without seats holds the lowest free seats in row-then-letter order, one per passenger", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 8);
  assert.equal((await book(app, USER_B, flightId, [{ name: "Zed", seat: "1B" }])).status, 201);

  const created = await book(app, USER_A, flightId, [
    { name: "Alice" },
    { name: "Bob" },
    { name: "Carol" },
  ]);

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.passengers, [
    { name: "Alice", seat: "1A" },
    { name: "Bob", seat: "1C" },
    { name: "Carol", seat: "1D" },
  ]);
  const statuses = await seatStatuses(app, flightId);
  assert.deepEqual(
    ["1A", "1B", "1C", "1D", "1E"].map((code) => statuses[code]),
    ["HELD", "HELD", "HELD", "HELD", "AVAILABLE"],
  );
});

test("POST booking with chosen seats pairs each passenger with the seat they named", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 6);

  const created = await book(app, USER_A, flightId, [
    { name: "Alice", seat: "1F" },
    { name: "Bob", seat: "1A" },
  ]);

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.passengers, [
    { name: "Alice", seat: "1F" },
    { name: "Bob", seat: "1A" },
  ]);
});

test("POST booking with one chosen seat already held is 409 SEATS_UNAVAILABLE naming only that seat, and holds nothing", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 6);
  assert.equal((await book(app, USER_B, flightId, [{ name: "Zed", seat: "1B" }])).status, 201);

  const response = await book(app, USER_A, flightId, [
    { name: "Alice", seat: "1A" },
    { name: "Bob", seat: "1B" },
  ]);

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "SEATS_UNAVAILABLE");
  assert.deepEqual(response.body.error.details, [
    { field: "seat", code: "SEAT_UNAVAILABLE", message: "1B" },
  ]);
  // Nothing about who holds it.
  assert.ok(!JSON.stringify(response.body).includes(ACCOUNT_B));
  // All or nothing (BR-SEAT-02): 1A was not held on the way.
  assert.equal((await seatStatuses(app, flightId))["1A"], "AVAILABLE");
});

test("POST booking for more passengers than free seats is 409 NOT_ENOUGH_SEATS and holds nothing", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 2);

  const response = await book(app, USER_A, flightId, [
    { name: "Alice" },
    { name: "Bob" },
    { name: "Carol" },
  ]);

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "NOT_ENOUGH_SEATS");
  assert.deepEqual(await seatStatuses(app, flightId), { "1A": "AVAILABLE", "1B": "AVAILABLE" });
});

test("POST booking naming a seat the flight does not have is 422 UNKNOWN_SEAT", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 6);

  const response = await book(app, USER_A, flightId, [
    { name: "Alice", seat: "1A" },
    { name: "Bob", seat: "30K" },
  ]);

  assert.equal(response.status, 422);
  assert.deepEqual(response.body.error.details, [
    { field: "seat", code: "UNKNOWN_SEAT", message: "30K" },
  ]);
  assert.equal((await seatStatuses(app, flightId))["1A"], "AVAILABLE");
});

test("POST booking rejects body shapes the rules forbid with 422 and the rule's code", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 6);
  const send = (body: unknown) =>
    request(app).post(`/api/flights/${flightId}/bookings`).set(as(USER_A)).send(body as object);

  const cases: Array<{ body: unknown; codes: string[] }> = [
    // BR-BOOK-01: counted before any passenger is read, so the invalid
    // passengers inside produce no issue of their own.
    { body: { passengers: Array.from({ length: 10 }, () => ({})) }, codes: ["INVALID_PASSENGER_COUNT"] },
    { body: { passengers: [] }, codes: ["INVALID_PASSENGER_COUNT"] },
    { body: {}, codes: ["INVALID_PASSENGER_COUNT"] },
    // BR-BOOK-09.
    {
      body: { passengers: [{ name: "Alice", seat: "1A" }, { name: "Bob" }] },
      codes: ["MIXED_SEAT_SELECTION"],
    },
    // BR-BOOK-02.
    {
      body: { passengers: [{ name: "Alice", seat: "1A" }, { name: "Bob", seat: "1A" }] },
      codes: ["DUPLICATE_SEAT"],
    },
    { body: { passengers: [{ name: "Alice", seat: "1a" }] }, codes: ["INVALID_SEAT"] },
    { body: { passengers: [{ name: "  " }] }, codes: ["REQUIRED"] },
    { body: { passengers: ["Alice"] }, codes: ["INVALID_PASSENGER"] },
    // The Day 44 body names what replaced it.
    {
      body: { passengerName: "Alice", passengers: [{ name: "Alice" }] },
      codes: ["UNSUPPORTED_FIELD"],
    },
    { body: { passengerName: "Alice" }, codes: ["UNSUPPORTED_FIELD", "INVALID_PASSENGER_COUNT"] },
  ];

  for (const { body, codes } of cases) {
    const response = await send(body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(response.body.error.code, "VALIDATION_FAILED");
    assert.deepEqual(
      response.body.error.details.map((issue: { code: string }) => issue.code),
      codes,
      JSON.stringify(body),
    );
  }

  // None of them held a seat.
  const statuses = await seatStatuses(app, flightId);
  assert.ok(Object.values(statuses).every((status) => status === "AVAILABLE"));
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

  const response = await book(app, USER_A, flightId, [{ name: "  " }]);

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
    request(app).post(`/api/flights/${flightId}/bookings`).send({ passengers: [{ name: "Alice" }] }),
    request(app).get("/api/bookings"),
    request(app).get(`/api/bookings/${bookingId}`),
    request(app).get("/api/bookings/by-reference/K7Q4PZ"),
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

test("GET by-reference returns the owner's booking; another account's, a missing and a malformed reference are the same 404", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app);
  const created = await book(app, USER_A, flightId);
  const { reference } = created.body as { reference: string };

  const own = await request(app).get(`/api/bookings/by-reference/${reference}`).set(as(USER_A));
  const admin = await request(app).get(`/api/bookings/by-reference/${reference}`).set(as(ADMIN));
  const otherAccount = await request(app)
    .get(`/api/bookings/by-reference/${reference}`)
    .set(as(USER_B));
  const missing = await request(app).get("/api/bookings/by-reference/ZZZZZZ").set(as(USER_B));
  const malformed = await request(app).get("/api/bookings/by-reference/k7q4p0").set(as(USER_A));

  assert.equal(own.status, 200);
  assert.deepEqual(own.body, created.body);
  assert.equal(admin.status, 200);
  for (const response of [otherAccount, missing, malformed]) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, otherAccount.body);
  }
  assert.equal(otherAccount.body.error.code, "BOOKING_NOT_FOUND");
});

test("another account cannot cancel the booking: 404, and the owner still sees it HELD", async () => {
  const { app } = createContext();
  const bookingOfA = await seedBooking(app, USER_A);

  const attempt = await request(app).delete(`/api/bookings/${bookingOfA}`).set(as(USER_B));
  const missing = await request(app).delete(`/api/bookings/${UNKNOWN_BOOKING_ID}`).set(as(USER_B));

  assert.equal(attempt.status, 404);
  assert.deepEqual(attempt.body, missing.body);

  const stillThere = await request(app).get(`/api/bookings/${bookingOfA}`).set(as(USER_A));
  assert.equal(stillThere.body.status, "HELD");
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

test("DELETE a HELD booking returns 204 then 409 on the owner's second cancel, and releases every seat once", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 3);
  const created = await book(app, USER_A, flightId, [{ name: "Alice" }, { name: "Bob" }]);
  assert.equal(created.status, 201);
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
