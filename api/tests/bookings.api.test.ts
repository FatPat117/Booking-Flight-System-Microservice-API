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
import { createPayForBooking } from "../src/payments/pay-for-booking.js";
import { nextBookingReference } from "./fixtures/bookings.js";
import {
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeSeats,
  TEST_AIRCRAFT,
  TEST_AIRPORTS,
} from "./fixtures/flights.js";
import {
  createInMemoryAircraftRepository,
  createInMemoryAirportRepository,
  createFakePaymentGateway,
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryHealthChecks,
  createInMemoryIdempotencyRepository,
  createInMemoryPaymentRepository,
  createInMemoryTransactionRunner,
  createUnusedReferenceData,
  type FakePaymentGateway,
  type InMemoryAuditRecorder,
  type InMemoryBookingRepository,
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

/** One clock for every use case of an app; tests move it to lapse holds. */
type TestClock = { now: Date };

function createContext(): {
  app: Express;
  audit: InMemoryAuditRecorder;
  clock: TestClock;
  /** For the expiry job's sweep, which no route exposes. */
  bookingRepository: InMemoryBookingRepository;
  /** Scripted charges and refunds; counts every call. */
  gateway: FakePaymentGateway;
} {
  const clock: TestClock = { now: FIXED_TIME };
  const getCurrentTime = () => clock.now;
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const airportRepository = createInMemoryAirportRepository(TEST_AIRPORTS);
  const aircraftRepository = createInMemoryAircraftRepository();
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const audit = createInMemoryAuditRecorder();
  const transactionRunner = createInMemoryTransactionRunner();
  const gateway = createFakePaymentGateway();
  const common = {
    auditRecorder: audit,
    outboxRepository: createNoopOutboxRepository(),
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime,
  };

  const app = createApp({
    getFlight: createGetFlight({ flightRepository, getCurrentTime }),
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
    payForBooking: createPayForBooking({
      ...common,
      bookingRepository,
      paymentRepository: createInMemoryPaymentRepository(),
      idempotencyRepository: createInMemoryIdempotencyRepository(),
      paymentGateway: gateway,
      logger: createMemoryLogger(),
      generatePaymentId: () => crypto.randomUUID(),
      reconcileAfterMs: 40_000,
    }),
    getBooking: createGetBooking({ bookingRepository, getCurrentTime }),
    getBookingByReference: createGetBookingByReference({ bookingRepository, getCurrentTime }),
    listBookings: createListBookings({ bookingRepository, getCurrentTime }),
    listFlights: createListFlights({ flightRepository, getCurrentTime }),
    ...createUnusedReferenceData(),
    logger: createMemoryLogger(),
    healthChecks: createInMemoryHealthChecks(),
    jwtSecret: TEST_JWT_SECRET,
  });

  seedAccess.set(app, aircraftRepository);
  return { app, audit, clock, bookingRepository, gateway };
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
      fares: { ECONOMY: 1_500_000 },
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

/** Who sits where, without the prices (the cases about seating only). */
function seatsOf(body: { passengers: Array<{ name: string; seat: string }> }) {
  return body.passengers.map(({ name, seat }) => ({ name, seat }));
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
  assert.deepEqual(created.body.passengers, [
    {
      name: "Alice Nguyen",
      seat: "1A",
      fareClass: "ECONOMY",
      price: { amount: 1_500_000, currency: "VND" },
    },
  ]);
  assert.deepEqual(created.body.total, { amount: 1_500_000, currency: "VND" });
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
  assert.deepEqual(seatsOf(created.body), [
    { name: "Alice", seat: "1A" },
    { name: "Bob", seat: "1C" },
    { name: "Carol", seat: "1D" },
  ]);
  assert.deepEqual(created.body.total, { amount: 4_500_000, currency: "VND" });
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
  assert.deepEqual(seatsOf(created.body), [
    { name: "Alice", seat: "1F" },
    { name: "Bob", seat: "1A" },
  ]);
});

test("a booking on a two-class flight shows each passenger's class and price and the total, on every read (BR-BOOK-03)", async () => {
  const { app } = createContext();
  const aircraftRepository = seedAccess.get(app);
  assert.ok(aircraftRepository);
  const twoClass = TEST_AIRCRAFT.find(({ id }) => id === FIXTURE_TWO_CLASS_AIRCRAFT_ID);
  assert.ok(twoClass);
  await aircraftRepository.create(twoClass);
  const flight = await request(app)
    .post("/api/flights")
    .set("Authorization", `Bearer ${ADMIN}`)
    .send({
      flightNumber: "VN350",
      origin: "SGN",
      destination: "HAN",
      aircraftRegistration: twoClass.registration,
      departureAt: "2026-12-10T08:00:00+07:00",
      arrivalAt: "2026-12-10T10:00:00+07:00",
      fares: { ECONOMY: 1_500_000, BUSINESS: 4_200_000 },
    });
  assert.equal(flight.status, 201);
  await request(app)
    .post(`/api/flights/${flight.body.id}/open`)
    .set("Authorization", `Bearer ${ADMIN}`);

  const created = await book(app, USER_A, flight.body.id, [
    { name: "Alice", seat: "1A" },
    { name: "Bob", seat: "3A" },
  ]);

  assert.equal(created.status, 201);
  const expected = {
    passengers: [
      { name: "Alice", seat: "1A", fareClass: "BUSINESS", price: { amount: 4_200_000, currency: "VND" } },
      { name: "Bob", seat: "3A", fareClass: "ECONOMY", price: { amount: 1_500_000, currency: "VND" } },
    ],
    total: { amount: 5_700_000, currency: "VND" },
  };
  const priced = (body: { passengers: unknown; total: unknown }) => ({
    passengers: body.passengers,
    total: body.total,
  });
  assert.deepEqual(priced(created.body), expected);

  const byId = await request(app).get(`/api/bookings/${created.body.id}`).set(as(USER_A));
  const byReference = await request(app)
    .get(`/api/bookings/by-reference/${created.body.reference}`)
    .set(as(USER_A));
  const list = await request(app).get("/api/bookings").set(as(USER_A));
  assert.deepEqual(priced(byId.body), expected);
  assert.deepEqual(priced(byReference.body), expected);
  assert.deepEqual(priced(list.body.items[0]), expected);
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
    request(app)
      .post(`/api/bookings/${bookingId}/payments`)
      .set("Idempotency-Key", "key-1")
      .send({ paymentMethodToken: "tok_success", amount: { amount: 1_500_000, currency: "VND" } }),
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

// ---------------------------------------------------------------------------
// Hold expiry (Day 48B, Decision 12, BR-BOOK-10). No job runs in these apps:
// every case is the window between the deadline and the job's next sweep.
// ---------------------------------------------------------------------------

/** HOLD_DURATION_MS after FIXED_TIME: the deadline of every hold made here. */
const HOLD_DEADLINE = new Date(FIXED_TIME.getTime() + 15 * 60 * 1000);

test("a lapsed hold reads EXPIRED by id, by reference and in the list before the job runs; its seat still shows HELD", async () => {
  const { app, clock } = createContext();
  const flightId = await seedFlight(app);
  const created = await book(app, USER_A, flightId);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "HELD");

  clock.now = HOLD_DEADLINE;

  const byId = await request(app).get(`/api/bookings/${created.body.id}`).set(as(USER_A));
  const byReference = await request(app)
    .get(`/api/bookings/by-reference/${created.body.reference}`)
    .set(as(USER_A));
  const list = await request(app).get("/api/bookings").set(as(USER_A));

  assert.equal(byId.body.status, "EXPIRED");
  assert.equal(byReference.body.status, "EXPIRED");
  assert.deepEqual(list.body.items.map((item: { status: string }) => item.status), ["EXPIRED"]);
  // Inventory is the job's (Decision 12): up to one interval late, accepted.
  assert.equal((await seatStatuses(app, flightId))["1A"], "HELD");
});

test("DELETE a lapsed hold is 409 BOOKING_EXPIRED, writes nothing, and leaves the seat for the job", async () => {
  const { app, audit, clock } = createContext();
  const flightId = await seedFlight(app);
  const created = await book(app, USER_A, flightId);
  clock.now = HOLD_DEADLINE;

  const response = await request(app).delete(`/api/bookings/${created.body.id}`).set(as(USER_A));

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    error: { code: "BOOKING_EXPIRED", message: "Booking hold has expired" },
  });
  assert.equal((await seatStatuses(app, flightId))["1A"], "HELD");
  assert.ok(audit.records.every((record) => record.action !== "BOOKING_CANCELLED"));
});

test("DELETE a booking the job already expired is the same 409 BOOKING_EXPIRED", async () => {
  const { app, clock, bookingRepository } = createContext();
  const flightId = await seedFlight(app);
  const created = await book(app, USER_A, flightId);
  clock.now = HOLD_DEADLINE;
  assert.equal((await bookingRepository.expireDueHolds(HOLD_DEADLINE, 50)).length, 1);

  const response = await request(app).delete(`/api/bookings/${created.body.id}`).set(as(USER_A));

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "BOOKING_EXPIRED");
  assert.equal((await seatStatuses(app, flightId))["1A"], "AVAILABLE");
});

test("another account's lapsed hold is 404 on DELETE; the owner 1 ms before the deadline still cancels with 204", async () => {
  const { app, clock } = createContext();
  const flightId = await seedFlight(app, 2);
  const lapsing = await book(app, USER_A, flightId);
  const valid = await book(app, USER_A, flightId);

  clock.now = new Date(HOLD_DEADLINE.getTime() - 1);
  const owner = await request(app).delete(`/api/bookings/${valid.body.id}`).set(as(USER_A));
  clock.now = HOLD_DEADLINE;
  const other = await request(app).delete(`/api/bookings/${lapsing.body.id}`).set(as(USER_B));

  assert.equal(owner.status, 204);
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, "BOOKING_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Paying for a booking (Day 49B, Decision 14)
// ---------------------------------------------------------------------------

/** The total of seedBooking's one ECONOMY passenger. */
const PAYMENT_BODY = {
  paymentMethodToken: "tok_success",
  amount: { amount: 1_500_000, currency: "VND" },
};

function pay(
  app: Express,
  accessToken: string,
  bookingId: string,
  { key = "key-1", body = PAYMENT_BODY }: { key?: string | null; body?: unknown } = {},
) {
  const call = request(app)
    .post(`/api/bookings/${bookingId}/payments`)
    .set(as(accessToken));
  return (key === null ? call : call.set("Idempotency-Key", key)).send(body as object);
}

test("POST payment answers 201 with the payment and the CONFIRMED booking, whose seat is now BOOKED", async () => {
  const { app } = createContext();
  const flightId = await seedFlight(app, 2);
  const booked = await book(app, USER_A, flightId);
  const bookingId = booked.body.id as string;

  const paid = await pay(app, USER_A, bookingId);

  assert.equal(paid.status, 201);
  assert.equal(paid.headers["idempotent-replayed"], undefined);
  assert.equal(paid.headers.location, undefined);
  assert.equal(paid.body.payment.status, "SUCCEEDED");
  assert.equal(paid.body.payment.bookingId, bookingId);
  assert.deepEqual(paid.body.payment.amount, { amount: 1_500_000, currency: "VND" });
  assert.match(paid.body.payment.providerReference, /^fake_ch_/);
  assert.deepEqual(paid.body.booking, { ...booked.body, status: "CONFIRMED" });

  const fetched = await request(app).get(`/api/bookings/${bookingId}`).set(as(USER_A));
  assert.equal(fetched.body.status, "CONFIRMED");
  assert.deepEqual(await seatStatuses(app, flightId), { "1A": "BOOKED", "1B": "AVAILABLE" });
});

test("a repeat with the same key and body gets the identical status and body, marked Idempotent-Replayed, charged once", async () => {
  const { app, gateway } = createContext();
  const bookingId = await seedBooking(app, USER_A);
  const first = await pay(app, USER_A, bookingId);

  // Same body, keys in another order: the same request (canonical fingerprint).
  const repeat = await pay(app, USER_A, bookingId, {
    body: { amount: { currency: "VND", amount: 1_500_000 }, paymentMethodToken: "tok_success" },
  });

  assert.equal(repeat.status, first.status);
  assert.deepEqual(repeat.body, first.body);
  assert.equal(repeat.headers["idempotent-replayed"], "true");
  assert.equal(gateway.charges.length, 1);
});

test("the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED and charges nothing (BR-PAY-02)", async () => {
  const { app, gateway } = createContext();
  const bookingId = await seedBooking(app, USER_A);
  await pay(app, USER_A, bookingId);

  const reused = await pay(app, USER_A, bookingId, {
    body: { ...PAYMENT_BODY, paymentMethodToken: "tok_decline" },
  });

  assert.equal(reused.status, 422);
  assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(gateway.charges.length, 1);
});

test("a missing key is 422 IDEMPOTENCY_KEY_REQUIRED; a malformed key or body is 422 VALIDATION_FAILED; none of them takes the key", async () => {
  const { app, gateway } = createContext();
  const bookingId = await seedBooking(app, USER_A);

  const missing = await pay(app, USER_A, bookingId, { key: null });
  const badKey = await pay(app, USER_A, bookingId, { key: "has space" });
  const badBody = await pay(app, USER_A, bookingId, {
    body: { paymentMethodToken: "", amount: { amount: 1.5, currency: "USD" } },
  });

  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(badKey.status, 422);
  assert.equal(badKey.body.error.code, "VALIDATION_FAILED");
  assert.deepEqual(
    badKey.body.error.details.map((issue: { field: string }) => issue.field),
    ["Idempotency-Key"],
  );
  assert.equal(badBody.status, 422);
  assert.equal(badBody.body.error.code, "VALIDATION_FAILED");
  assert.deepEqual(
    badBody.body.error.details.map((issue: { field: string }) => issue.field),
    ["paymentMethodToken", "amount.amount", "amount.currency"],
  );
  assert.equal(gateway.charges.length, 0);

  // key-1 was never claimed by the malformed body, so it is free.
  assert.equal((await pay(app, USER_A, bookingId)).status, 201);
});

test("an amount other than the booking total is 422 PAYMENT_AMOUNT_MISMATCH naming the total; the key stays usable", async () => {
  const { app, gateway } = createContext();
  const bookingId = await seedBooking(app, USER_A);

  const mismatch = await pay(app, USER_A, bookingId, {
    body: { ...PAYMENT_BODY, amount: { amount: 1_000_000, currency: "VND" } },
  });

  assert.equal(mismatch.status, 422);
  assert.deepEqual(mismatch.body, {
    error: {
      code: "PAYMENT_AMOUNT_MISMATCH",
      message: "amount must equal the booking total: 1500000 VND",
    },
  });
  assert.equal(gateway.charges.length, 0);
  assert.equal((await pay(app, USER_A, bookingId)).status, 201);
});

test("a declined card is 402 PAYMENT_DECLINED and the booking stays HELD; a new key can pay", async () => {
  const { app, gateway } = createContext();
  const bookingId = await seedBooking(app, USER_A);
  gateway.willCharge({ outcome: "declined", reason: "card_declined" });

  const declined = await pay(app, USER_A, bookingId, {
    body: { ...PAYMENT_BODY, paymentMethodToken: "tok_decline" },
  });

  assert.equal(declined.status, 402);
  assert.deepEqual(declined.body, {
    error: { code: "PAYMENT_DECLINED", message: "Payment was declined: card_declined" },
  });
  const fetched = await request(app).get(`/api/bookings/${bookingId}`).set(as(USER_A));
  assert.equal(fetched.body.status, "HELD");
  assert.equal((await pay(app, USER_A, bookingId, { key: "key-2" })).status, 201);
});

test("an unknown gateway outcome is 202 with the PROCESSING payment and no token; it is not stored, so the same key is 409 IDEMPOTENCY_KEY_IN_PROGRESS (BR-PAY-08)", async () => {
  const { app, gateway } = createContext();
  const bookingId = await seedBooking(app, USER_A);
  gateway.willCharge({ outcome: "lost-response" });

  const accepted = await pay(app, USER_A, bookingId);

  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers["idempotent-replayed"], undefined);
  assert.deepEqual(Object.keys(accepted.body.payment), [
    "id",
    "bookingId",
    "status",
    "amount",
    "providerReference",
    "createdAt",
  ]);
  assert.equal(accepted.body.payment.bookingId, bookingId);
  assert.equal(accepted.body.payment.status, "PROCESSING");
  assert.equal(accepted.body.payment.providerReference, null);

  const again = await pay(app, USER_A, bookingId);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "IDEMPOTENCY_KEY_IN_PROGRESS");
  const fetched = await request(app).get(`/api/bookings/${bookingId}`).set(as(USER_A));
  assert.equal(fetched.body.status, "HELD");
  assert.equal(gateway.charges.length, 1);
});

test("a CONFIRMED booking, or a hold with 60 s or less left, is 409 BOOKING_NOT_PAYABLE without a charge", async () => {
  const { app, gateway, clock } = createContext();
  const confirmed = await seedBooking(app, USER_A);
  await pay(app, USER_A, confirmed);
  const nearlyLapsed = await seedBooking(app, USER_A);

  const again = await pay(app, USER_A, confirmed, { key: "key-2" });
  clock.now = new Date(FIXED_TIME.getTime() + 14 * 60_000);
  const late = await pay(app, USER_A, nearlyLapsed, { key: "key-3" });

  for (const response of [again, late]) {
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "BOOKING_NOT_PAYABLE");
  }
  assert.equal(gateway.charges.length, 1);
});

test("another account's booking is 404 BOOKING_NOT_FOUND and an admin is 403; neither charges", async () => {
  const { app, gateway } = createContext();
  const bookingOfA = await seedBooking(app, USER_A);

  const byB = await pay(app, USER_B, bookingOfA);
  const byAdmin = await pay(app, ADMIN, bookingOfA);

  assert.equal(byB.status, 404);
  assert.deepEqual(byB.body, {
    error: { code: "BOOKING_NOT_FOUND", message: "Booking was not found" },
  });
  assert.equal(byAdmin.status, 403);
  assert.equal(byAdmin.body.error.code, "FORBIDDEN");
  assert.equal(gateway.charges.length, 0);
  const fetched = await request(app).get(`/api/bookings/${bookingOfA}`).set(as(USER_A));
  assert.equal(fetched.body.status, "HELD");
});
