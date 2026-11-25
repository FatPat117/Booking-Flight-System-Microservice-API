import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import {
  MANIFEST_FLIGHT_SQL,
  MANIFEST_PASSENGERS_SQL,
} from "../../src/reports/postgres/admin-reports-sql.js";
import { createPostgresAdminReports } from "../../src/reports/postgres/postgres-admin-reports.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { makeBooking, passengersFor } from "../fixtures/bookings.js";
import { FIXTURE_TWO_CLASS_AIRCRAFT_ID, makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * Day 53 Step 3 (Decision 19): a report built from two statements must
 * agree with itself while bookings change under it. A gate pauses the
 * manifest between its statements; a booking is cancelled and committed
 * meanwhile; then the manifest continues.
 *
 * - REPEATABLE READ (the adapter): both statements see the snapshot of the
 *   first, so the counts and the list describe the world before the cancel.
 * - Control, test-only: the same two statements at READ COMMITTED take a
 *   snapshot each, and the report contradicts itself.
 */

const NOW = new Date("2026-10-10T00:00:00.000Z");
const ADMIN = { kind: "admin" } as const;
let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

/** A paused point: `reached` resolves when the paused code gets there; `release` lets it go on. */
function gate() {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    release,
    async pass() {
      reach();
      await released;
    },
  };
}

const bookings = () => createPostgresBookingRepository(dataSource);
const transactions = () => createPostgresTransactionRunner(dataSource);

async function confirmed(flightId: string, seats: string[]) {
  const repository = bookings();
  const booking = makeBooking({ flightId, holdExpiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString() });
  await transactions().run(async () => {
    const held = await repository.holdSeats(
      flightId,
      booking.id,
      { kind: "chosen", seats: seats.map((code) => parseSeatPosition(code)!) },
      NOW,
    );
    if (held.outcome !== "held") throw new Error(held.outcome);
    await repository.create({ ...booking, passengers: passengersFor(held.seats) });
  });
  assert.equal((await repository.confirmHold(booking.id, ADMIN, NOW)).outcome, "confirmed");
  return booking;
}

/** A flight with 3 CONFIRMED passengers: one booking of two (3A, 3B), one of one (3C). */
async function flightWithThreePassengers() {
  const flight = makeFlight({ aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID });
  assert.deepEqual(await createPostgresFlightRepository(dataSource).create(flight), { outcome: "created" });
  const pair = await confirmed(flight.id, ["3A", "3B"]);
  await confirmed(flight.id, ["3C"]);
  return { flight, pair };
}

async function cancelCommitted(bookingId: string) {
  const outcome = await transactions().run(() => bookings().cancel(bookingId, ADMIN, NOW, "CUSTOMER"));
  assert.equal(outcome.outcome, "cancelled");
}

const economyBooked = (classes: ReadonlyArray<{ fareClass: string; booked: number }>) =>
  classes.find((seats) => seats.fareClass === "ECONOMY")?.booked;

test("Snapshot — a booking cancelled between the manifest's two statements: counts and list both show the world before it", async () => {
  const { flight, pair } = await flightWithThreePassengers();
  const paused = gate();
  const reports = createPostgresAdminReports(dataSource, { betweenManifestStatements: () => paused.pass() });

  const reading = reports.findManifest(flight.id, NOW);
  await paused.reached;
  await cancelCommitted(pair.id); // committed while the report is between its statements
  paused.release();
  const manifest = await reading;

  assert.ok(manifest);
  assert.equal(economyBooked(manifest.classes), 3);
  assert.equal(manifest.passengers.length, 3);
  // The cancel did commit: a manifest read now sees one passenger and one booked seat.
  const now = await createPostgresAdminReports(dataSource).findManifest(flight.id, NOW);
  assert.equal(economyBooked(now!.classes), 1);
  assert.equal(now!.passengers.length, 1);
});

test("Snapshot control (test-only) — the same two statements at READ COMMITTED contradict each other: 3 booked above 1 passenger", async () => {
  const { flight, pair } = await flightWithThreePassengers();

  const result = await dataSource.transaction("READ COMMITTED", async (manager) => {
    const [summary] = (await manager.query(MANIFEST_FLIGHT_SQL, [flight.id, NOW])) as Array<{
      classes: Array<{ fareClass: string; booked: number }>;
    }>;
    await cancelCommitted(pair.id); // another connection, committed between the two statements
    const passengers = (await manager.query(MANIFEST_PASSENGERS_SQL, [flight.id])) as unknown[];
    return { booked: economyBooked(summary!.classes), passengers: passengers.length };
  });

  assert.deepEqual(result, { booked: 3, passengers: 1 });
});

test("Snapshot — load factor is one statement: under 40 concurrent holds and cancels, every class adds up on every read", async () => {
  const flights = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID });
  await flights.create(flight);
  const date = flight.departureAt.slice(0, 10);
  const reports = createPostgresAdminReports(dataSource);
  const economy = Array.from({ length: 18 }, (_, index) => `${3 + Math.floor(index / 6)}${"ABCDEF"[index % 6]}`);

  const writers = economy.slice(0, 10).map(async (seat) => {
    const booking = await confirmed(flight.id, [seat]);
    await cancelCommitted(booking.id);
    await confirmed(flight.id, [seat]);
  });
  const reads: Array<Awaited<ReturnType<typeof reports.loadFactor>>> = [];
  const reader = (async () => {
    for (let index = 0; index < 20; index += 1) {
      reads.push(await reports.loadFactor({ dateFrom: date, dateTo: date, limit: 5 }, NOW));
    }
  })();
  await Promise.all([...writers, reader]);
  reads.push(await reports.loadFactor({ dateFrom: date, dateTo: date, limit: 5 }, NOW));

  for (const page of reads) {
    for (const seats of page.items[0]!.classes) {
      assert.equal(seats.available + seats.held + seats.booked, seats.total);
    }
  }
  assert.equal(economyBooked(reads.at(-1)!.items[0]!.classes), 10);
});
