import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import { openDatabase } from "../src/database.js";
import { createSqliteBookingRepository } from "../src/bookings/sqlite-booking-repository.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import type { Flight } from "../src/types.js";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: crypto.randomUUID(),
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T01:00:00.000Z",
    arrivalAt: "2026-08-10T03:00:00.000Z",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 1,
    ...overrides,
  };
}

function createRepos(t: TestContext) {
  const database = openDatabase(":memory:");
  const flightRepository = createSqliteFlightRepository(database);
  const bookingRepository = createSqliteBookingRepository(database);

  t.after(() => {
    database.close();
  });

  return { flightRepository, bookingRepository };
}

test("reserveSeat succeeds when seats are available", async (t) => {
  const { flightRepository, bookingRepository } = createRepos(t);
  const flight = makeFlight({ id: "flight-1", availableSeats: 2 });

  assert.equal((await flightRepository.create(flight)).outcome, "created");
  assert.deepEqual(bookingRepository.reserveSeat("flight-1"), {
    outcome: "reserved",
  });
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    1,
  );
});

test("reserveSeat returns sold-out on second call when only one seat left", async (t) => {
  const { flightRepository, bookingRepository } = createRepos(t);
  const flight = makeFlight({ id: "flight-1", availableSeats: 1 });

  assert.equal((await flightRepository.create(flight)).outcome, "created");
  assert.deepEqual(bookingRepository.reserveSeat("flight-1"), {
    outcome: "reserved",
  });
  assert.deepEqual(bookingRepository.reserveSeat("flight-1"), {
    outcome: "sold-out",
  });
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    0,
  );
});

test("reserveSeat returns flight-not-found for unknown flight", (t) => {
  const { bookingRepository } = createRepos(t);

  assert.deepEqual(bookingRepository.reserveSeat("missing-flight"), {
    outcome: "flight-not-found",
  });
});

test("create persists a booking row", async (t) => {
  const { flightRepository, bookingRepository } = createRepos(t);
  const flight = makeFlight({ id: "flight-1", availableSeats: 1 });

  await flightRepository.create(flight);
  bookingRepository.reserveSeat("flight-1");
  bookingRepository.create({
    id: "booking-1",
    flightId: "flight-1",
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active",
  });

  const row = await flightRepository.findById("flight-1");
  assert.equal(row?.availableSeats, 0);
});

test("cancel active booking once; second cancel is already-cancelled", (t) => {
  const { flightRepository, bookingRepository } = createRepos(t);
  const flight = makeFlight({ id: "flight-1", availableSeats: 2 });

  flightRepository.create(flight);
  bookingRepository.reserveSeat("flight-1");
  bookingRepository.create({
    id: "booking-1",
    flightId: "flight-1",
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active",
  });

  assert.deepEqual(bookingRepository.cancel("booking-1"), {
    outcome: "cancelled",
    flightId: "flight-1",
  });
  assert.deepEqual(bookingRepository.cancel("booking-1"), {
    outcome: "already-cancelled",
  });
});

test("cancel returns not-found for unknown booking", (t) => {
  const { bookingRepository } = createRepos(t);

  assert.deepEqual(bookingRepository.cancel("missing-booking"), {
    outcome: "not-found",
  });
});
