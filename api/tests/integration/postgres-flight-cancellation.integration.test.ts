import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import type { HoldSeatsResult, SeatHoldRequest } from "../../src/bookings/booking-repository.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createCancelFlight } from "../../src/flights/cancel-flight.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { TransactionRunner } from "../../src/transactions/transaction-runner.js";
import type { Flight } from "../../src/types.js";
import { makeBooking, passengersFor } from "../fixtures/bookings.js";
import { makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * Day 52 Step 2 — cancelling a flight changes only the flight row
 * (Decision 18, option B). These tests force the two orders in which a
 * hold and a flight cancellation can meet on that row:
 *
 * - the hold first: it holds the flight's share lock (taken by the hold
 *   statement), so the cancel's UPDATE waits until the hold commits, and the
 *   hold's booking is one the cascade must then cancel;
 * - the cancel first: its UPDATE holds the row, holds queue behind it, and
 *   once it commits they re-check the on-sale condition against the
 *   CANCELLED row and take nothing — the auto hold too, whose SKIP LOCKED
 *   applies to seats, not to the flight's share lock.
 *
 * The cancel never waits for a seat, so neither order can deadlock.
 */

let dataSource: DataSource;

const NOW = new Date("2026-07-20T00:00:00.000Z");
const ADMIN = { accountId: "aaaaaaaa-0000-4000-8000-000000000001" };

function bookingRepository() {
  return createPostgresBookingRepository(dataSource);
}

function chosen(code: string): SeatHoldRequest {
  const position = parseSeatPosition(code);
  assert.ok(position, code);
  return { kind: "chosen", seats: [position] };
}

/** Holds `request` for a new booking and stores it, in the current transaction. */
async function holdAndStore(flight: Flight, request: SeatHoldRequest): Promise<HoldSeatsResult> {
  const booking = makeBooking({ flightId: flight.id, holdExpiresAt: "2026-07-20T00:15:00.000Z" });
  const held = await bookingRepository().holdSeats(flight.id, booking.id, request, NOW);
  if (held.outcome === "held") {
    await bookingRepository().create({ ...booking, passengers: passengersFor(held.seats) });
  }
  return held;
}

/** Resolves once at least `count` backends wait for a lock — no sleep-and-hope. */
async function untilWaiting(count: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = (await dataSource.query(
      `SELECT count(*)::int AS "waiting" FROM pg_locks WHERE NOT granted`,
    )) as Array<{ waiting: number }>;
    if ((row?.waiting ?? 0) >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${count} backends queued on a lock within 5 s`);
}

/**
 * A transaction runner whose transactions stay open after their work until
 * `commit()`: the work's locks are held while the test starts the other side.
 */
function gatedRunner() {
  const real = createPostgresTransactionRunner(dataSource);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const workDone = new Promise<void>((resolve) => {
    reached = resolve;
  });

  const runner: TransactionRunner = {
    run: (work) =>
      real.run(async () => {
        const value = await work();
        reached();
        await gate;
        return value;
      }),
  };
  return { runner, workDone, commit: release };
}

function cancelFlightWith(transactionRunner: TransactionRunner) {
  return createCancelFlight({
    flightRepository: createPostgresFlightRepository(dataSource),
    bookingRepository: bookingRepository(),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => NOW,
  });
}

async function flightStatus(flightId: string): Promise<string> {
  const [row] = (await dataSource.query(`SELECT "status" FROM "flights" WHERE "id" = $1`, [
    flightId,
  ])) as Array<{ status: string }>;
  return row?.status ?? "missing";
}

async function takenSeats(flightId: string): Promise<string[]> {
  const rows = (await dataSource.query(
    `SELECT "row" || "letter" || ':' || "status" AS "seat" FROM "flight_seats"
     WHERE "flight_id" = $1 AND "status" <> 'AVAILABLE' ORDER BY "row", "letter"`,
    [flightId],
  )) as Array<{ seat: string }>;
  return rows.map((row) => row.seat);
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

test("a hold holding the flight's share lock makes the cancel wait; the hold commits first and its booking is left to the cascade", async () => {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  const hold = gatedRunner();
  const holding = hold.runner.run(() => holdAndStore(flight, chosen("12A")));
  await hold.workDone;

  const cancelling = cancelFlightWith(createPostgresTransactionRunner(dataSource))(flight.id, ADMIN);
  await untilWaiting(1);
  assert.equal(await flightStatus(flight.id), "OPEN", "the cancel must still be waiting");

  hold.commit();
  assert.equal((await holding).outcome, "held");
  const cancelled = await cancelling;

  assert.equal(cancelled.outcome, "cancelled");
  assert.ok(cancelled.outcome === "cancelled");
  assert.equal(cancelled.remainingBookings, 1);
  assert.equal(await flightStatus(flight.id), "CANCELLED");
  // Only the flight changed: the hold's seat and booking wait for the cascade.
  assert.deepEqual(await takenSeats(flight.id), ["12A:HELD"]);
});

test("a cancel holding the flight row makes holds wait; once it commits, chosen and auto holds are sales-closed and take no seat", async () => {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  const cancel = gatedRunner();
  const cancelling = cancelFlightWith(cancel.runner)(flight.id, ADMIN);
  await cancel.workDone;

  const runner = createPostgresTransactionRunner(dataSource);
  const chosenHold = runner.run(() => holdAndStore(flight, chosen("12A")));
  const autoHold = runner.run(() =>
    holdAndStore(flight, { kind: "auto", count: 2, fareClass: "ECONOMY" }),
  );
  await untilWaiting(2);

  cancel.commit();

  assert.equal((await cancelling).outcome, "cancelled");
  assert.deepEqual(await chosenHold, { outcome: "sales-closed" });
  assert.deepEqual(await autoHold, { outcome: "sales-closed" });
  assert.deepEqual(await takenSeats(flight.id), []);
  const [bookings] = (await dataSource.query(
    `SELECT count(*)::int AS "count" FROM "bookings" WHERE "flight_id" = $1`,
    [flight.id],
  )) as Array<{ count: number }>;
  assert.equal(bookings?.count, 0);
});

test("cancelling writes one FLIGHT_CANCELLED audit row in the flight's transaction, and a second cancel writes none", async () => {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  const cancelFlight = cancelFlightWith(createPostgresTransactionRunner(dataSource));

  assert.equal((await cancelFlight(flight.id, ADMIN)).outcome, "cancelled");
  assert.equal((await cancelFlight(flight.id, ADMIN)).outcome, "already-cancelled");

  const rows = (await dataSource.query(
    `SELECT "actor_type", "actor_id", "metadata" FROM "audit_logs"
     WHERE "action" = 'FLIGHT_CANCELLED' AND "target_id" = $1`,
    [flight.id],
  )) as Array<{ actor_type: string; actor_id: string; metadata: Record<string, unknown> }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.actor_type, "account");
  assert.equal(rows[0]?.actor_id, ADMIN.accountId);
  assert.deepEqual(rows[0]?.metadata, { flightNumber: flight.flightNumber, previousStatus: "OPEN" });
});
