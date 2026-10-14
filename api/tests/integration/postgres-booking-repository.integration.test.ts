import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import type { BookingAccessScope } from "../../src/bookings/booking-repository.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { Flight } from "../../src/types.js";
import { makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences, keepFirstSeats } from "./flight-references.js";

/**
 * Runs against the real booking_db Postgres container (see Dev.md), same
 * shape as the other *.integration.test.ts files in this directory. Covers
 * PostgresBookingRepository's own methods sequentially, checked in the
 * flight_seats rows themselves — concurrent races are covered separately
 * (postgres-booking-race.integration.test.ts).
 */

let dataSource: DataSource;

const NOW = new Date("2026-10-10T00:00:00.000Z");

const OWNER_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER: BookingAccessScope = { kind: "owner", accountId: OWNER_ACCOUNT_ID };

function makeBooking(flightId: string) {
  return {
    id: crypto.randomUUID(),
    flightId,
    ownerAccountId: OWNER_ACCOUNT_ID,
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active" as const,
    seat: null,
  };
}

/** An OPEN flight bookable at NOW with exactly `seats` seats (1A, 1B, ...). */
async function seedFlight(seats: number): Promise<Flight> {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  await keepFirstSeats(dataSource, flight.id, seats);
  return flight;
}

async function seatRows(flightId: string) {
  return (await dataSource.query(
    `SELECT "row" || "letter" AS seat, "status", "booking_id"
     FROM "flight_seats" WHERE "flight_id" = $1 ORDER BY "row", "letter"`,
    [flightId],
  )) as Array<{ seat: string; status: string; booking_id: string | null }>;
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

test("reserveSeat: the claimed seat row is BOOKED for that booking; the next call is sold-out", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = await seedFlight(1);
  const booking = makeBooking(flight.id);

  const first = await createPostgresTransactionRunner(dataSource).run(async () => {
    const reserved = await bookingRepository.reserveSeat(flight.id, booking.id, NOW);
    await bookingRepository.create(booking);
    return reserved;
  });

  assert.deepEqual(first, { outcome: "reserved", seat: "1A" });
  assert.deepEqual(await seatRows(flight.id), [
    { seat: "1A", status: "BOOKED", booking_id: booking.id },
  ]);
  assert.deepEqual(
    await bookingRepository.reserveSeat(flight.id, crypto.randomUUID(), NOW),
    { outcome: "sold-out" },
  );
});

test("reserveSeat: a seat claimed for a booking that is never inserted fails at commit (deferred FK)", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = await seedFlight(1);

  // Outside a transaction the statement commits on its own, so the deferred
  // check runs at its end: the seat cannot point at a booking that never exists.
  await assert.rejects(
    bookingRepository.reserveSeat(flight.id, crypto.randomUUID(), NOW),
    { constraint: "FK_flight_seats_booking_id" },
  );
  assert.deepEqual(await seatRows(flight.id), [
    { seat: "1A", status: "AVAILABLE", booking_id: null },
  ]);
});

test("reserveSeat: flight-not-found for an unknown flight id", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);

  const result = await bookingRepository.reserveSeat(crypto.randomUUID(), crypto.randomUUID(), NOW);
  assert.deepEqual(result, { outcome: "flight-not-found" });
});

test("cancel: cancelled with flightId, its seat row back to AVAILABLE with no booking; then already-cancelled", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = await seedFlight(1);
  const booking = makeBooking(flight.id);
  await createPostgresTransactionRunner(dataSource).run(async () => {
    await bookingRepository.reserveSeat(flight.id, booking.id, NOW);
    await bookingRepository.create(booking);
  });

  const first = await bookingRepository.cancel(booking.id, OWNER);
  assert.deepEqual(first, { outcome: "cancelled", flightId: flight.id });
  assert.deepEqual(await seatRows(flight.id), [
    { seat: "1A", status: "AVAILABLE", booking_id: null },
  ]);

  const second = await bookingRepository.cancel(booking.id, OWNER);
  assert.deepEqual(second, { outcome: "already-cancelled" });
});

test("cancel: not-found for an unknown booking id", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);

  const result = await bookingRepository.cancel(crypto.randomUUID(), OWNER);
  assert.deepEqual(result, { outcome: "not-found" });
});

test("foreign key: a booking with an unknown flight_id is rejected by Postgres", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const orphanBooking = makeBooking(crypto.randomUUID());

  await assert.rejects(() => bookingRepository.create(orphanBooking));

  const rows = await dataSource.query(`SELECT id FROM bookings`);
  assert.equal(rows.length, 0);
});
