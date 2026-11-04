import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { makeBooking } from "../fixtures/bookings.js";
import { makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { assertGlobalInvariants, findInvariantViolations } from "./invariants.js";

/**
 * Day 51 Step 0 — the snapshot audit after Day 50's race test C.
 *
 * In READ COMMITTED one statement reads one snapshot, taken when it starts.
 * A statement that waits for a lock and then finds rows *by a foreign key*
 * (seats `WHERE booking_id IN (…)`) finds them as they were before the wait.
 * `confirmHold` is such a statement: its booking UPDATE can wait for a
 * cancel, a seat change or the expiry job, and its seat CTE then finds the
 * booking's seats in the old snapshot. It has no pre-lock statement; it is
 * correct only because of an invariant: **a HELD booking's seats never
 * change** (seats are written by the hold, seat change is CONFIRMED-only).
 *
 * The first two tests are the interleavings that do happen; the third is
 * the control — a writer that breaks the invariant, test-only — and shows
 * the invariant is what keeps confirm correct, so it must keep a test.
 */

let dataSource: DataSource;

const OWNER = "11111111-1111-4111-8111-111111111111";
const OWNER_SCOPE = { kind: "owner", accountId: OWNER } as const;
const NOW = new Date("2026-07-20T00:00:00.000Z");

function repository() {
  return createPostgresBookingRepository(dataSource);
}

function seat(code: string) {
  const position = parseSeatPosition(code);
  assert.ok(position, code);
  return position;
}

/** A one-passenger HELD booking on `code`, the way the hold use case writes it. */
async function heldBooking(code: string): Promise<{ flightId: string; bookingId: string }> {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  const booking = makeBooking({ flightId: flight.id, ownerAccountId: OWNER });

  await createPostgresTransactionRunner(dataSource).run(async () => {
    const held = await repository().holdSeats(flight.id, booking.id, { kind: "chosen", seats: [seat(code)] }, NOW);
    assert.equal(held.outcome, "held", JSON.stringify(held));
    if (held.outcome !== "held") return;
    const [first] = held.seats;
    await repository().create({
      ...booking,
      passengers: [{ name: `P${code}`, seat: first?.seat ?? null, fareClass: first?.fareClass ?? null, price: first?.price ?? null }],
    });
  });
  return { flightId: flight.id, bookingId: booking.id };
}

async function seatsOf(flightId: string): Promise<string[]> {
  const rows = (await dataSource.query(
    `SELECT "row" || "letter" || ':' || "status" AS "seat" FROM "flight_seats"
     WHERE "flight_id" = $1 AND "booking_id" IS NOT NULL ORDER BY "row", "letter"`,
    [flightId],
  )) as Array<{ seat: string }>;
  return rows.map((row) => row.seat);
}

async function bookingStatus(bookingId: string): Promise<string> {
  const [row] = (await dataSource.query(`SELECT "status" FROM "bookings" WHERE "id" = $1`, [
    bookingId,
  ])) as Array<{ status: string }>;
  return row?.status ?? "missing";
}

/** Resolves once some backend is waiting for a lock — no sleep-and-hope. */
async function untilSomeoneWaitsForALock(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = (await dataSource.query(
      `SELECT count(*)::int AS "waiting" FROM pg_locks WHERE NOT granted`,
    )) as Array<{ waiting: number }>;
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("nobody queued on a lock within 5 s");
}

/**
 * Runs `step` in a transaction that stays open until the returned function
 * is called: `step` holds its locks while the test starts a confirm.
 */
async function openTransaction<T>(step: () => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: (value: T) => void;
  const stepDone = new Promise<T>((resolve) => {
    reached = resolve;
  });

  const committed = createPostgresTransactionRunner(dataSource).run(async () => {
    const value = await step();
    reached(value);
    await gate;
  });

  const value = await stepDone;
  return {
    value,
    async commit() {
      release();
      await committed;
    },
  };
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

test("confirm queued behind a cancel of the same HELD booking matches nothing after the wait and books no seat", async () => {
  const { flightId, bookingId } = await heldBooking("12A");

  const cancel = await openTransaction(() => repository().cancel(bookingId, OWNER_SCOPE, NOW));
  assert.equal(cancel.value.outcome, "cancelled");

  const confirm = repository().confirmHold(bookingId, OWNER_SCOPE, NOW);
  await untilSomeoneWaitsForALock();
  await cancel.commit();

  assert.equal((await confirm).outcome, "not-payable");
  assert.equal(await bookingStatus(bookingId), "CANCELLED");
  assert.deepEqual(await seatsOf(flightId), []);
  await assertGlobalInvariants(dataSource);
});

test("confirm queued behind a refused seat change on a HELD booking books exactly the original seat", async () => {
  const { flightId, bookingId } = await heldBooking("12A");

  const change = await openTransaction(() =>
    repository().changeSeat(bookingId, 1, seat("14C"), OWNER_SCOPE, NOW),
  );
  assert.equal(change.value.outcome, "not-changeable");

  const confirm = repository().confirmHold(bookingId, OWNER_SCOPE, NOW);
  await untilSomeoneWaitsForALock();
  await change.commit();

  assert.equal((await confirm).outcome, "confirmed");
  assert.deepEqual(await seatsOf(flightId), ["12A:BOOKED"]);
  await assertGlobalInvariants(dataSource);
});

test("control — a writer that moves a HELD booking's seat (test-only) makes a queued confirm book from its old snapshot and break the invariants", async () => {
  const { flightId, bookingId } = await heldBooking("12A");
  const from = seat("12A");
  const to = seat("14C");

  // What a HELD seat change would do, written here and nowhere in src/.
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  await runner.query(`SELECT 1 FROM "bookings" WHERE "id" = $1 FOR UPDATE`, [bookingId]);
  await runner.query(
    `UPDATE "flight_seats" SET "status" = 'AVAILABLE', "booking_id" = NULL
     WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3`,
    [flightId, from.row, from.letter],
  );
  await runner.query(
    `UPDATE "flight_seats" SET "status" = 'HELD', "booking_id" = $4
     WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3`,
    [flightId, to.row, to.letter, bookingId],
  );
  await runner.query(
    `UPDATE "booking_passengers" SET "seat_row" = $2, "seat_letter" = $3 WHERE "booking_id" = $1`,
    [bookingId, to.row, to.letter],
  );

  const confirm = repository().confirmHold(bookingId, OWNER_SCOPE, NOW);
  await untilSomeoneWaitsForALock();
  await runner.commitTransaction();
  await runner.release();

  assert.equal((await confirm).outcome, "confirmed");
  // The confirm found 12A by booking_id in its old snapshot; 12A no longer
  // belongs to the booking, so nothing was booked — 14C stays HELD for a
  // CONFIRMED booking.
  assert.deepEqual(await seatsOf(flightId), ["14C:HELD"]);
  const violations = await findInvariantViolations(dataSource);
  assert.ok(
    violations.some((violation) => violation.startsWith("seat status agrees with its booking")),
    violations.join("\n"),
  );
});
