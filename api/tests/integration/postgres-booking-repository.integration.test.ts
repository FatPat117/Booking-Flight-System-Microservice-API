import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import type { BookingAccessScope } from "../../src/bookings/booking-repository.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import type { Flight } from "../../src/types.js";
import { makeFlight as makeFixtureFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * Runs against the real booking_db Postgres container (see Dev.md), same
 * shape as the other *.integration.test.ts files in this directory. Covers
 * PostgresBookingRepository's own methods sequentially — concurrent races
 * are covered separately (postgres-booking-race.integration.test.ts).
 */

let dataSource: DataSource;

/** OPEN and departing in 2027, so bookable at NOW. */
function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return makeFixtureFlight({ availableSeats: 1, ...overrides });
}

const NOW = new Date("2026-10-10T00:00:00.000Z");

const OWNER_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER: BookingAccessScope = { kind: "owner", accountId: OWNER_ACCOUNT_ID };

function makeBooking(flightId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    flightId,
    ownerAccountId: OWNER_ACCOUNT_ID,
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
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

test("reserveSeat: reserved then sold-out, decrementing available_seats in SQL", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);

  const first = await bookingRepository.reserveSeat(flight.id, NOW);
  assert.deepEqual(first, { outcome: "reserved" });

  const afterFirst = await flightRepository.findById(flight.id);
  assert.equal(afterFirst?.availableSeats, 0);

  const second = await bookingRepository.reserveSeat(flight.id, NOW);
  assert.deepEqual(second, { outcome: "sold-out" });
});

test("reserveSeat: flight-not-found for an unknown flight id", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);

  const result = await bookingRepository.reserveSeat(crypto.randomUUID(), NOW);
  assert.deepEqual(result, { outcome: "flight-not-found" });
});

test("cancel: cancelled with flightId via RETURNING, then already-cancelled", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);
  await bookingRepository.reserveSeat(flight.id, NOW);
  const booking = makeBooking(flight.id);
  await bookingRepository.create(booking);

  const first = await bookingRepository.cancel(booking.id, OWNER);
  assert.deepEqual(first, { outcome: "cancelled", flightId: flight.id });

  const second = await bookingRepository.cancel(booking.id, OWNER);
  assert.deepEqual(second, { outcome: "already-cancelled" });
});

test("cancel: not-found for an unknown booking id", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);

  const result = await bookingRepository.cancel(crypto.randomUUID(), OWNER);
  assert.deepEqual(result, { outcome: "not-found" });
});

test("releaseSeat: increments available_seats in SQL", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);
  await bookingRepository.reserveSeat(flight.id, NOW);

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
