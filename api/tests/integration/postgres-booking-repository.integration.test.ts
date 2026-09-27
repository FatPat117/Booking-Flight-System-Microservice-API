import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import type { Flight } from "../../src/types.js";

/**
 * Runs against the real booking_db Postgres container (see Dev.md), same
 * shape as the other *.integration.test.ts files in this directory. Covers
 * PostgresBookingRepository's own methods sequentially — concurrent races
 * are covered separately (postgres-booking-race.integration.test.ts).
 */

let dataSource: DataSource;

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

function makeBooking(flightId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    flightId,
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active" as const,
    ...overrides,
  };
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights" CASCADE');
});

after(async () => {
  await dataSource.destroy();
});

test("reserveSeat: reserved then sold-out, decrementing available_seats in SQL", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);

  const first = await bookingRepository.reserveSeat(flight.id);
  assert.deepEqual(first, { outcome: "reserved" });

  const afterFirst = await flightRepository.findById(flight.id);
  assert.equal(afterFirst?.availableSeats, 0);

  const second = await bookingRepository.reserveSeat(flight.id);
  assert.deepEqual(second, { outcome: "sold-out" });
});

test("reserveSeat: flight-not-found for an unknown flight id", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);

  const result = await bookingRepository.reserveSeat(crypto.randomUUID());
  assert.deepEqual(result, { outcome: "flight-not-found" });
});

test("cancel: cancelled with flightId via RETURNING, then already-cancelled", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);
  await bookingRepository.reserveSeat(flight.id);
  const booking = makeBooking(flight.id);
  await bookingRepository.create(booking);

  const first = await bookingRepository.cancel(booking.id);
  assert.deepEqual(first, { outcome: "cancelled", flightId: flight.id });

  const second = await bookingRepository.cancel(booking.id);
  assert.deepEqual(second, { outcome: "already-cancelled" });
});

test("cancel: not-found for an unknown booking id", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);

  const result = await bookingRepository.cancel(crypto.randomUUID());
  assert.deepEqual(result, { outcome: "not-found" });
});

test("releaseSeat: increments available_seats in SQL", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);
  await bookingRepository.reserveSeat(flight.id);

  await bookingRepository.releaseSeat(flight.id);

  const afterRelease = await flightRepository.findById(flight.id);
  assert.equal(afterRelease?.availableSeats, 1);
});

test("foreign key: a booking with an unknown flight_id is rejected by Postgres", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const orphanBooking = makeBooking(crypto.randomUUID());

  await assert.rejects(() => bookingRepository.create(orphanBooking));

  const rows = await dataSource.query(`SELECT id FROM bookings`);
  assert.equal(rows.length, 0);
});
