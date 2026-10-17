import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import type { AuditRecorder } from "../../src/audit/audit-recorder.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import type {
  BookingRepository,
  ExpiredHold,
} from "../../src/bookings/booking-repository.js";
import { createCancelBooking } from "../../src/bookings/cancel-booking.js";
import {
  createCreateBooking,
  HOLD_DURATION_MS,
} from "../../src/bookings/create-booking.js";
import { createExpireHolds } from "../../src/bookings/expire-holds.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { isDeadlockDetected } from "../../src/postgres/postgres-errors.js";
import { resolveEntityManager } from "../../src/postgres/transaction-context.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences, keepFirstSeats } from "./flight-references.js";

/**
 * Hold expiry under real concurrency (Day 48B, Decision 12, BR-BOOK-10):
 * separate pg Pool connections running the real use cases. The fake cannot
 * fail any of this — SKIP LOCKED, the row-lock re-check that makes cancel
 * and expiry exclusive, the seat lock order, and a batch rolling back are
 * all Postgres semantics.
 */

const OWNER = { accountId: "11111111-1111-4111-8111-111111111111" };
const OWNER_SCOPE = { kind: "owner", accountId: OWNER.accountId } as const;
/** When every hold here is made; fixture flights depart in 2027. */
const HELD_AT = new Date("2026-07-20T00:00:00.000Z");
/** Their deadline: the first instant they are expired (BR-BOOK-10). */
const DEADLINE = new Date(HELD_AT.getTime() + HOLD_DURATION_MS);

let dataSource: DataSource;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBookingAt(now: Date, bookingRepository?: BookingRepository) {
  return createCreateBooking({
    bookingRepository: bookingRepository ?? createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateId: () => crypto.randomUUID(),
    generateReference: nextBookingReference,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => now,
  });
}

function cancelBookingAt(now: Date, bookingRepository?: BookingRepository) {
  return createCancelBooking({
    bookingRepository: bookingRepository ?? createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => now,
  });
}

function expireHoldsAt(
  now: Date,
  options: {
    bookingRepository?: BookingRepository;
    auditRecorder?: AuditRecorder;
    batchSize?: number;
  } = {},
) {
  return createExpireHolds({
    bookingRepository: options.bookingRepository ?? createPostgresBookingRepository(dataSource),
    auditRecorder: options.auditRecorder ?? createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getCurrentTime: () => now,
    batchSize: options.batchSize ?? 50,
    maxBatches: 20,
  });
}

/** A bookable flight; `seats` keeps only the first n of its 120 (1A, 1B, ...). */
async function createFlight(seats?: number): Promise<string> {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  if (seats !== undefined) {
    await keepFirstSeats(dataSource, flight.id, seats);
  }
  return flight.id;
}

/** A HELD booking made at HELD_AT, so it lapses at DEADLINE. */
async function hold(
  flightId: string,
  passengers: Array<{ name: string; seat?: string }> = [{ name: "Alice" }],
): Promise<string> {
  const result = await createBookingAt(HELD_AT)(flightId, { passengers }, OWNER);
  assert.equal(result.outcome, "created", JSON.stringify(result));
  return result.outcome === "created" ? result.booking.id : "";
}

async function statusOf(bookingId: string): Promise<string | undefined> {
  const [row] = (await dataSource.query(
    `SELECT "status" FROM "bookings" WHERE "id" = $1`,
    [bookingId],
  )) as Array<{ status: string }>;
  return row?.status;
}

/** How each booking ended, from the audit log: action → count, per booking. */
async function endings(): Promise<Map<string, string[]>> {
  const rows = (await dataSource.query(
    `SELECT "target_id", "action" FROM "audit_logs"
     WHERE "action" IN ('BOOKING_EXPIRED', 'BOOKING_CANCELLED')`,
  )) as Array<{ target_id: string; action: string }>;
  const byBooking = new Map<string, string[]>();
  for (const row of rows) {
    byBooking.set(row.target_id, [...(byBooking.get(row.target_id) ?? []), row.action]);
  }
  return byBooking;
}

async function outboxCount(eventType: string): Promise<number> {
  const [row] = (await dataSource.query(
    `SELECT count(*)::int AS "count" FROM "outbox" WHERE "event_type" = $1`,
    [eventType],
  )) as Array<{ count: number }>;
  return row?.count ?? 0;
}

/**
 * The invariant every test ends on: a seat is HELD exactly when its booking
 * is HELD, and no booking in a final state (EXPIRED, CANCELLED) still owns a
 * seat — nothing released twice, nothing left behind.
 */
async function assertSeatsMatchBookings(flightId: string) {
  const [state] = (await dataSource.query(
    `SELECT
       (SELECT count(*)::int FROM "flight_seats" s
          JOIN "bookings" b ON b."id" = s."booking_id"
          WHERE s."flight_id" = $1 AND b."status" <> 'HELD') AS "ownedByEnded",
       (SELECT count(*)::int FROM "flight_seats"
          WHERE "flight_id" = $1 AND "status" = 'HELD') AS "heldSeats",
       (SELECT count(*)::int FROM "booking_passengers" p
          JOIN "bookings" b ON b."id" = p."booking_id"
          WHERE b."flight_id" = $1 AND b."status" = 'HELD') AS "heldPassengers"`,
    [flightId],
  )) as Array<{ ownedByEnded: number; heldSeats: number; heldPassengers: number }>;
  assert.ok(state);
  assert.equal(state.ownedByEnded, 0, "a seat still belongs to an ended booking");
  assert.equal(state.heldSeats, state.heldPassengers, "HELD seats ≠ passengers of HELD bookings");
  return state;
}

/** One end per booking: never both expired and cancelled, never twice. */
async function assertOneEndingEach() {
  for (const [bookingId, actions] of await endings()) {
    assert.equal(actions.length, 1, `${bookingId} ended ${actions.join(" + ")}`);
  }
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query(
    'TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE',
  );
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

// ---- A / B: several sweepers at once ----

const DUE = 50;
const SWEEPERS = 4;
const BATCH = 7;
/** Time a batch keeps its rows locked after the sweep statement returned. */
const BATCH_WORK_MS = 100;

type BatchLog = Array<{ sweeper: number; returnedAt: number; count: number }>;

/**
 * Wraps a repository so each batch records when its sweep statement
 * returned, then keeps the transaction (and its row locks) open for
 * BATCH_WORK_MS — a stand-in for the audit and outbox writes of a big batch.
 */
function slowBatches(
  repository: BookingRepository,
  sweeper: number,
  log: BatchLog,
): BookingRepository {
  return {
    ...repository,
    async expireDueHolds(now, limit) {
      const holds = await repository.expireDueHolds(now, limit);
      log.push({ sweeper, returnedAt: performance.now(), count: holds.length });
      if (holds.length > 0) {
        await sleep(BATCH_WORK_MS);
      }
      return holds;
    },
  };
}

/** Two non-empty batches of different sweepers whose locked windows overlapped. */
function overlappingBatches(log: BatchLog): number {
  const working = log.filter((batch) => batch.count > 0);
  let overlaps = 0;
  for (const [i, a] of working.entries()) {
    for (const b of working.slice(i + 1)) {
      if (a.sweeper !== b.sweeper && Math.abs(a.returnedAt - b.returnedAt) < BATCH_WORK_MS) {
        overlaps += 1;
      }
    }
  }
  return overlaps;
}

async function raceSweepers(makeRepository: () => BookingRepository) {
  const flightId = await createFlight();
  for (let i = 0; i < DUE; i += 1) {
    await hold(flightId);
  }

  const log: BatchLog = [];
  const startedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: SWEEPERS }, (_, sweeper) =>
      expireHoldsAt(DEADLINE, {
        bookingRepository: slowBatches(makeRepository(), sweeper, log),
        batchSize: BATCH,
      })(),
    ),
  );
  const elapsedMs = Math.round(performance.now() - startedAt);

  assert.equal(results.reduce((sum, result) => sum + result.expired, 0), DUE);
  const ended = await endings();
  assert.equal(ended.size, DUE);
  await assertOneEndingEach();
  assert.equal(await outboxCount("booking-expired"), DUE);
  const state = await assertSeatsMatchBookings(flightId);
  assert.equal(state.heldSeats, 0);

  return { results, log, elapsedMs };
}

test("Test A — 4 sweepers in batches of 7 over 50 due holds: each expired exactly once, and their batches run side by side", async (t) => {
  const { results, log, elapsedMs } = await raceSweepers(() =>
    createPostgresBookingRepository(dataSource),
  );

  // SKIP LOCKED: a sweeper takes the next unlocked rows instead of waiting
  // for another's batch to commit, so batches of different sweepers hold
  // their locks at the same time.
  const overlaps = overlappingBatches(log);
  assert.ok(overlaps > 0, "no two sweepers ever worked at the same time");
  t.diagnostic(
    `per sweeper ${results.map((result) => result.expired).join("/")}, ` +
      `${overlaps} overlapping batch pairs, ${elapsedMs} ms`,
  );
});

/**
 * Control for Test A — exists only here, never in src/. The sweep's own
 * statement with plain FOR UPDATE instead of SKIP LOCKED, seats released
 * the same way.
 */
function createWaitingSweepRepository(): BookingRepository {
  const repository = createPostgresBookingRepository(dataSource);
  return {
    ...repository,
    async expireDueHolds(now, limit): Promise<ExpiredHold[]> {
      const rows = (await resolveEntityManager(dataSource).query(
        `WITH due AS (
           SELECT "id" FROM "bookings"
           WHERE "status" = 'HELD' AND "hold_expires_at" <= $1
           ORDER BY "hold_expires_at", "id" LIMIT $2
           FOR UPDATE
         ), expired AS (
           UPDATE "bookings" booking SET "status" = 'EXPIRED'
           FROM due WHERE booking."id" = due."id"
           RETURNING booking."id", booking."reference", booking."flight_id",
                     booking."owner_account_id", booking."hold_expires_at"
         ), released AS (
           UPDATE "flight_seats" seat SET "status" = 'AVAILABLE', "booking_id" = NULL
           FROM expired WHERE seat."booking_id" = expired."id"
           -- RETURNING shows the new row: booking_id is already NULL there.
           RETURNING expired."id" AS "booking_id", seat."row" || seat."letter" AS "seat"
         )
         SELECT expired.*, array_agg(released."seat") AS "seats"
         FROM expired JOIN released ON released."booking_id" = expired."id"
         GROUP BY expired."id", expired."reference", expired."flight_id",
                  expired."owner_account_id", expired."hold_expires_at"`,
        [now, limit],
      )) as Array<{
        id: string;
        reference: string;
        flight_id: string;
        owner_account_id: string;
        hold_expires_at: Date;
        seats: string[];
      }>;
      return rows.map((row) => ({
        bookingId: row.id,
        reference: row.reference,
        flightId: row.flight_id,
        ownerAccountId: row.owner_account_id,
        holdExpiresAt: row.hold_expires_at.toISOString(),
        seats: row.seats,
      }));
    },
  };
}

test("Test B — control without SKIP LOCKED: still each expired once, but the sweepers queue behind each other", async (t) => {
  const { results, log, elapsedMs } = await raceSweepers(createWaitingSweepRepository);

  // A waiting sweeper re-checks `status = 'HELD'` after the lock is freed, so
  // it never expires a booking twice — correctness holds either way. What
  // SKIP LOCKED buys is that sweepers do not wait: here a batch's statement
  // only returns once the batch it waited on has committed.
  assert.equal(overlappingBatches(log), 0, "a waiting sweep returned while another batch held its locks");
  t.diagnostic(
    `per sweeper ${results.map((result) => result.expired).join("/")}, ${elapsedMs} ms`,
  );
});

// ---- C: cancel against expiry ----

const ROUNDS = 20;

test("Test C — cancel and expiry at the deadline, together: expiry wins every round, one end, seats freed once", async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight(2);
    const bookingId = await hold(flightId, [{ name: "Alice" }, { name: "Bob" }]);

    const [cancelled, expired] = await Promise.all([
      cancelBookingAt(DEADLINE)(bookingId, OWNER_SCOPE, OWNER),
      expireHoldsAt(DEADLINE)(),
    ]);

    // BR-BOOK-10: at the deadline the hold is on the expired side for both.
    assert.deepEqual(cancelled, { outcome: "expired" });
    assert.equal(expired.expired, 1);
    assert.equal(await statusOf(bookingId), "EXPIRED");
    await assertSeatsMatchBookings(flightId);
  }
  await assertOneEndingEach();
  assert.equal((await endings()).size, ROUNDS);
});

test("Test C (clocks apart) — cancel reads 1 ms before the deadline, expiry at it: both may match, exactly one ends the booking", async (t) => {
  const tally = { cancelled: 0, expired: 0 };

  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight(2);
    const bookingId = await hold(flightId, [{ name: "Alice" }, { name: "Bob" }]);

    const [cancelled, expired] = await Promise.all([
      cancelBookingAt(new Date(DEADLINE.getTime() - 1))(bookingId, OWNER_SCOPE, OWNER),
      expireHoldsAt(DEADLINE)(),
    ]);

    // The row lock lets one through; the other re-checks status = 'HELD'
    // against the committed row and matches nothing.
    if (cancelled.outcome === "cancelled") {
      assert.equal(expired.expired, 0);
      assert.equal(await statusOf(bookingId), "CANCELLED");
      tally.cancelled += 1;
    } else {
      assert.deepEqual(cancelled, { outcome: "expired" });
      assert.equal(expired.expired, 1);
      assert.equal(await statusOf(bookingId), "EXPIRED");
      tally.expired += 1;
    }
    await assertSeatsMatchBookings(flightId);
  }
  await assertOneEndingEach();
  assert.equal((await endings()).size, ROUNDS);
  assert.equal(await outboxCount("booking-cancelled") + await outboxCount("booking-expired"), ROUNDS);
  t.diagnostic(`${ROUNDS} rounds: ${tally.cancelled} cancelled, ${tally.expired} expired`);
});

// ---- D: expiry against a new hold on the seat it frees ----

test("Test D — the last seat's hold lapses while someone books it: the new booking gets it or is refused, never shared", async (t) => {
  const tally = { created: 0, refused: 0 };

  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight(1);
    const lapsed = await hold(flightId);

    const [expired, booked] = await Promise.all([
      expireHoldsAt(DEADLINE)(),
      // Staggered a little so both orders happen across the rounds.
      sleep(round % 3).then(() =>
        createBookingAt(DEADLINE)(flightId, { passengers: [{ name: "Carol" }] }, OWNER),
      ),
    ]);

    assert.equal(expired.expired, 1);
    assert.equal(await statusOf(lapsed), "EXPIRED");
    if (booked.outcome === "created") {
      tally.created += 1;
    } else {
      assert.equal(booked.outcome, "not-enough-seats");
      tally.refused += 1;
    }
    const state = await assertSeatsMatchBookings(flightId);
    assert.equal(state.heldSeats, booked.outcome === "created" ? 1 : 0);
  }

  // A refusal is the auto hold skipping a seat still locked by the sweep:
  // correct (BR-SEAT-01 holds), and the seat is free a moment later.
  t.diagnostic(`${ROUNDS} rounds: ${tally.created} got the freed seat, ${tally.refused} refused`);
});

// ---- E: lock order between a chosen-seat hold and a release ----

/** Long enough for a statement to reach its lock and queue there. */
const QUEUE_MS = 50;

/**
 * Locks one seat in a transaction of its own until the returned function is
 * called: a gate that lines the racers up on 12A in a known order.
 */
async function gateSeat(flightId: string, letter: string): Promise<() => Promise<void>> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  await runner.query(
    `SELECT 1 FROM "flight_seats"
     WHERE "flight_id" = $1 AND "row" = 12 AND "letter" = $2 FOR UPDATE`,
    [flightId, letter],
  );
  return async () => {
    await runner.commitTransaction();
    await runner.release();
  };
}

/**
 * The interleaving the Day 48B lock-order table warned about, forced:
 * 1. a gate holds 12A;
 * 2. a hold on [12A, 12B] arrives and queues on 12A (it locks in order);
 * 3. the release of the booking holding 12A + 12B arrives. Locking 12A
 *    first, it queues behind the hold holding nothing. Locking 12B first,
 *    it takes 12B and then queues on 12A;
 * 4. the gate opens: the hold gets 12A and asks for 12B. Ordered release:
 *    12B is free, the hold finishes, then the release runs. Backwards
 *    release: 12B is the release's, which waits for 12A — a cycle.
 */
async function raceHoldAgainstRelease(
  release: (flightId: string, bookingId: string) => Promise<unknown>,
) {
  const flightId = await createFlight();
  const holder = await hold(flightId, [
    { name: "Alice", seat: "12A" },
    { name: "Bob", seat: "12B" },
  ]);

  const openGate = await gateSeat(flightId, "A");
  const booking = createBookingAt(new Date(DEADLINE.getTime() - 1))(
    flightId,
    { passengers: [{ name: "Carol", seat: "12A" }, { name: "Dan", seat: "12B" }] },
    OWNER,
  );
  await sleep(QUEUE_MS);
  const released = release(flightId, holder);
  await sleep(QUEUE_MS);
  await openGate();

  const settled = await Promise.allSettled([released, booking]);
  await assertSeatsMatchBookings(flightId);
  return { flightId, holder, settled };
}

/**
 * Control for Test E — exists only here, never in src/. The real cancel
 * statement with its seats locked in the opposite order, (row, letter)
 * DESC: one order an unordered `UPDATE … WHERE booking_id` may take.
 */
function cancelLockingSeatsBackwards(_: string, bookingId: string) {
  return resolveEntityManager(dataSource).query(
    `WITH cancelled AS (
       UPDATE "bookings" SET "status" = 'CANCELLED'
       WHERE "id" = $1 AND "status" = 'HELD'
       RETURNING "id"
     ), locked AS (
       SELECT seat."flight_id", seat."row", seat."letter" FROM "flight_seats" seat
       WHERE seat."booking_id" IN (SELECT "id" FROM cancelled)
       ORDER BY seat."row" DESC, seat."letter" DESC
       FOR UPDATE
     )
     UPDATE "flight_seats" seat SET "status" = 'AVAILABLE', "booking_id" = NULL
     FROM locked
     WHERE seat."flight_id" = locked."flight_id"
       AND seat."row" = locked."row" AND seat."letter" = locked."letter"`,
    [bookingId],
  );
}

test("Test E — control: a release locking 12B before 12A, against a hold on [12A, 12B], deadlocks (40P01)", async (t) => {
  // Each deadlock costs deadlock_timeout (1 s).
  const rounds = 5;
  let deadlocks = 0;

  for (let round = 0; round < rounds; round += 1) {
    const { settled } = await raceHoldAgainstRelease(cancelLockingSeatsBackwards);
    const rejected = settled.filter((result) => result.status === "rejected");
    for (const result of rejected) {
      assert.ok(isDeadlockDetected(result.reason), String(result.reason));
    }
    deadlocks += rejected.length;
  }

  // The cycle the Day 48B lock-order table predicted, every round.
  assert.equal(deadlocks, rounds, "every round should deadlock");
  t.diagnostic(`${rounds} rounds: ${deadlocks} deadlocks`);
});

function assertNoDeadlock(settled: PromiseSettledResult<unknown>[]) {
  for (const result of settled) {
    assert.equal(result.status, "fulfilled", String(result.status === "rejected" && result.reason));
  }
}

test("Test E — the real cancel locks 12A before 12B: same interleaving, no deadlock; the hold finds the seats taken, then the cancel frees them", async () => {
  for (let round = 0; round < 5; round += 1) {
    const { flightId, holder, settled } = await raceHoldAgainstRelease((_, bookingId) =>
      createPostgresBookingRepository(dataSource).cancel(bookingId, OWNER_SCOPE, HELD_AT),
    );

    assertNoDeadlock(settled);
    const [released, booked] = settled;
    assert.deepEqual(released.status === "fulfilled" && released.value, {
      outcome: "cancelled",
      flightId,
    });
    // The hold went first through the gate and saw both seats still HELD.
    assert.equal(booked.status === "fulfilled" && booked.value.outcome, "seats-unavailable");
    assert.equal(await statusOf(holder), "CANCELLED");
  }
});

test("Test E — the real sweep shares that lock order: same interleaving against expiry, no deadlock", async () => {
  for (let round = 0; round < 5; round += 1) {
    const { holder, settled } = await raceHoldAgainstRelease(() =>
      createPostgresBookingRepository(dataSource).expireDueHolds(DEADLINE, 50),
    );

    assertNoDeadlock(settled);
    const [, booked] = settled;
    assert.equal(booked.status === "fulfilled" && booked.value.outcome, "seats-unavailable");
    assert.equal(await statusOf(holder), "EXPIRED");
  }
});

// ---- F: a failing batch ----

test("Test F — a batch whose audit write fails rolls back whole; batches committed before it stay", async () => {
  const flightId = await createFlight();
  const bookings = [await hold(flightId), await hold(flightId), await hold(flightId)];
  const audit = createPostgresAuditRecorder(dataSource);
  let records = 0;
  const failingThird: AuditRecorder = {
    async record(input) {
      records += 1;
      if (records === 3) {
        throw new Error("audit store down");
      }
      await audit.record(input);
    },
  };

  // Batches of 2: the first commits, the second fails on its audit write.
  // Same deadline for all three, so `id` decides which booking is last.
  await assert.rejects(
    () => expireHoldsAt(DEADLINE, { auditRecorder: failingThird, batchSize: 2 })(),
    /audit store down/,
  );

  const statuses = await Promise.all(bookings.map(statusOf));
  assert.deepEqual([...statuses].sort(), ["EXPIRED", "EXPIRED", "HELD"]);
  const third = bookings[statuses.indexOf("HELD")] as string;
  // The status change, the seat release and the outbox row went with it.
  assert.equal((await endings()).size, 2);
  assert.equal((await endings()).has(third), false);
  assert.equal(await outboxCount("booking-expired"), 2);
  const state = await assertSeatsMatchBookings(flightId);
  assert.equal(state.heldSeats, 1);

  // The next run retries it.
  assert.deepEqual(await expireHoldsAt(DEADLINE)(), { expired: 1, batches: 1, exhausted: false });
  assert.equal(await statusOf(third), "EXPIRED");
});
