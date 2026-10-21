import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { DataSource } from "typeorm";

import { formatSeatPosition } from "../../src/aircraft/seat-position.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import type {
  BookingRepository,
  HoldSeatsResult,
  SeatHoldRequest,
} from "../../src/bookings/booking-repository.js";
import { createCancelBooking } from "../../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../../src/bookings/create-booking.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { resolveEntityManager } from "../../src/postgres/transaction-context.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { FIXTURE_FARES, makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences, keepFirstSeats } from "./flight-references.js";

/**
 * Seat allocation under real concurrency (Day 47, ADR-004 addendum): separate
 * pg Pool connections running parallel transactions through the real
 * CreateBooking / CancelBooking use cases.
 *
 * Pool size matters for what "concurrent" means: the DataSource sets no
 * `extra.max`, so node-postgres's default Pool max (10) applies — 20 calls
 * means at most 10 open transactions at any instant, the rest queue for a
 * connection. Still real contention on the same seat rows.
 */

const OWNER_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_SCOPE = { kind: "owner", accountId: OWNER_ACCOUNT_ID } as const;
const OWNER_ACTOR = { accountId: OWNER_ACCOUNT_ID };
const NOW = new Date("2026-07-20T00:00:00.000Z");
const ONE_SEAT = { kind: "auto", count: 1 } as const;

let dataSource: DataSource;

function createCreateBookingUseCase(
  bookingRepository: BookingRepository = createPostgresBookingRepository(dataSource),
) {
  return createCreateBooking({
    bookingRepository,
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateId: () => crypto.randomUUID(),
    generateReference: nextBookingReference,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => NOW,
  });
}

function createCancelBookingUseCase() {
  return createCancelBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => NOW,
  });
}

async function createFlightWithSeats(seats: number): Promise<string> {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  await keepFirstSeats(dataSource, flight.id, seats);
  return flight.id;
}

async function bookConcurrently(
  flightId: string,
  callers: number,
  createBooking = createCreateBookingUseCase(),
) {
  const results = await Promise.all(
    Array.from({ length: callers }, (_, i) =>
      createBooking(flightId, { passengers: [{ name: `Passenger ${i}` }] }, OWNER_ACTOR),
    ),
  );
  const seats = results.flatMap((r) =>
    r.outcome === "created"
      ? r.booking.passengers.flatMap((p) => (p.seat === null ? [] : [p.seat]))
      : [],
  );
  return {
    created: results.filter((r) => r.outcome === "created").length,
    soldOut: results.filter((r) => r.outcome === "not-enough-seats").length,
    seats,
  };
}

/**
 * The invariant every race below must keep, read straight from the tables:
 * each HELD booking holds exactly one HELD seat and each HELD seat belongs to
 * a HELD booking (every booking in this file has one passenger; several are
 * covered in postgres-booking-hold-race.integration.test.ts).
 */
async function seatState(flightId: string) {
  const [row] = (await dataSource.query(
    `SELECT
       (SELECT count(*)::int FROM "bookings" WHERE "flight_id" = $1 AND "status" = 'HELD') AS "active",
       (SELECT count(*)::int FROM "flight_seats" WHERE "flight_id" = $1 AND "status" = 'HELD') AS "booked",
       (SELECT count(*)::int FROM "flight_seats" WHERE "flight_id" = $1 AND "status" = 'AVAILABLE') AS "available",
       (SELECT count(*)::int FROM "flight_seats" seat
          JOIN "bookings" booking ON booking."id" = seat."booking_id"
          WHERE seat."flight_id" = $1 AND booking."status" = 'HELD') AS "paired"`,
    [flightId],
  )) as Array<{ active: number; booked: number; available: number; paired: number }>;
  assert.ok(row);
  return row;
}

function assertConsistent(state: Awaited<ReturnType<typeof seatState>>) {
  assert.equal(state.booked, state.active, "HELD seats must equal HELD bookings");
  assert.equal(state.paired, state.active, "every HELD seat must belong to a HELD booking");
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

test("Test A — 20 concurrent bookings on a 5-seat flight: 5 created on 5 different seats, 15 sold-out", async () => {
  const flightId = await createFlightWithSeats(5);

  const { created, soldOut, seats } = await bookConcurrently(flightId, 20);

  assert.equal(created, 5);
  assert.equal(soldOut, 15);
  assert.deepEqual([...seats].sort(), ["1A", "1B", "1C", "1D", "1E"]);
  const state = await seatState(flightId);
  assert.equal(state.booked, 5);
  assert.equal(state.available, 0);
  assertConsistent(state);
});

test("Test B — 20 concurrent bookings on a 50-seat flight: all 20 created on 20 different seats, none sold-out", async () => {
  const flightId = await createFlightWithSeats(50);

  const { created, soldOut, seats } = await bookConcurrently(flightId, 20);

  assert.equal(created, 20);
  assert.equal(soldOut, 0);
  assert.equal(new Set(seats).size, 20);
  const state = await seatState(flightId);
  assert.equal(state.booked, 20);
  assert.equal(state.available, 30);
  assertConsistent(state);
});

/**
 * Control for Test B: the real statement minus SKIP LOCKED — exists only
 * here, never in src/. Every caller picks the same lowest seat and waits on
 * its lock. It does NOT end in a false sold-out on Postgres: LockRows sits
 * under Limit in the plan, so a row that fails the READ COMMITTED re-check
 * (now taken) is dropped and the next row of the sort is tried — the waiter
 * walks 1A, 1B, ... waiting on each in turn. The cost is the queue: every
 * booking waits for the in-flight transactions in front of it (Test C2).
 */
function createRepositoryWithoutSkipLocked(): BookingRepository {
  const repository = createPostgresBookingRepository(dataSource);
  return {
    ...repository,
    async holdSeats(flightId, bookingId, request, now) {
      assertOneAutoSeat(request);
      const [rows] = (await resolveEntityManager(dataSource).query(
        `WITH picked AS (
           SELECT seat."flight_id", seat."row", seat."letter"
           FROM "flight_seats" seat
           JOIN "flights" flight ON flight."id" = seat."flight_id"
           WHERE seat."flight_id" = $1 AND seat."status" = 'AVAILABLE'
             AND flight."status" = 'OPEN'
             AND flight."departure_at" - interval '1 hour' > $3
           ORDER BY seat."row", seat."letter"
           LIMIT 1
           FOR UPDATE OF seat
           FOR SHARE OF flight
         )
         UPDATE "flight_seats" seat
         SET "status" = 'HELD', "booking_id" = $2
         FROM picked
         WHERE (seat."flight_id", seat."row", seat."letter")
             = (picked."flight_id", picked."row", picked."letter")
         RETURNING seat."row", seat."letter"`,
        [flightId, bookingId, now],
      )) as [Array<{ row: number; letter: string }>, number];
      return oneSeatResult(rows);
    },
  };
}

/** The controls replicate the one-seat statement only. */
function assertOneAutoSeat(request: SeatHoldRequest): void {
  assert.deepEqual(request, { kind: "auto", count: 1 });
}

function oneSeatResult(rows: Array<{ row: number; letter: string }>): HoldSeatsResult {
  const [claimed] = rows;
  return claimed === undefined
    ? { outcome: "not-enough-seats" }
    : {
        outcome: "held",
        // About seat allocation only: priced at the economy-only fixture's fare.
        seats: [
          {
            seat: formatSeatPosition(claimed),
            fareClass: "ECONOMY",
            price: FIXTURE_FARES.ECONOMY,
          },
        ],
      };
}

test("Test C1 — control: without SKIP LOCKED, Test B still books 20 distinct seats (no false sold-out on Postgres)", async (t) => {
  const flightId = await createFlightWithSeats(50);

  const started = performance.now();
  const { created, soldOut, seats } = await bookConcurrently(
    flightId,
    20,
    createCreateBookingUseCase(createRepositoryWithoutSkipLocked()),
  );
  t.diagnostic(
    `without SKIP LOCKED: ${created} created, ${soldOut} sold-out of 20 ` +
      `(50 seats) in ${Math.round(performance.now() - started)} ms`,
  );

  assert.equal(created, 20);
  assert.equal(new Set(seats).size, 20);
  assertConsistent(await seatState(flightId));
});

/**
 * Control C3 (Day 48A): no row lock at all — the optimistic version the
 * ADR-004 addendum describes but Day 47 never built. The pick is a plain
 * snapshot read; the outer UPDATE re-checks `status = 'AVAILABLE'` (OCC).
 * Every caller that read the same lowest seat aims at it; after the first
 * commits, the rest re-check against a taken row, match nothing and report
 * sold-out although 30 seats are free. Exists only here, never in src/.
 */
function createRepositoryWithoutRowLock(): BookingRepository {
  const repository = createPostgresBookingRepository(dataSource);
  return {
    ...repository,
    async holdSeats(flightId, bookingId, request, now) {
      assertOneAutoSeat(request);
      const [rows] = (await resolveEntityManager(dataSource).query(
        `UPDATE "flight_seats" seat
         SET "status" = 'HELD', "booking_id" = $2
         WHERE (seat."flight_id", seat."row", seat."letter") = (
             SELECT candidate."flight_id", candidate."row", candidate."letter"
             FROM "flight_seats" candidate
             JOIN "flights" flight ON flight."id" = candidate."flight_id"
             WHERE candidate."flight_id" = $1 AND candidate."status" = 'AVAILABLE'
               AND flight."status" = 'OPEN'
               AND flight."departure_at" - interval '1 hour' > $3
             ORDER BY candidate."row", candidate."letter"
             LIMIT 1)
           AND seat."status" = 'AVAILABLE'
         RETURNING seat."row", seat."letter"`,
        [flightId, bookingId, now],
      )) as [Array<{ row: number; letter: string }>, number];
      return oneSeatResult(rows);
    },
  };
}

test("Test C3 — control: with no row lock (pick, then conditional UPDATE), Test B reports false sold-outs but never double-books", async (t) => {
  const flightId = await createFlightWithSeats(50);

  const { created, soldOut, seats } = await bookConcurrently(
    flightId,
    20,
    createCreateBookingUseCase(createRepositoryWithoutRowLock()),
  );
  t.diagnostic(
    `without any row lock: ${created} created, ${soldOut} false sold-out of 20 (50 seats)`,
  );

  // Measured Day 48A: 15–16 of 20 every run (10 runs). Asserted only as
  // "some", so the control fails if Postgres stops producing the effect.
  assert.ok(soldOut > 0, "expected false sold-outs without a row lock");
  assert.equal(created + soldOut, 20);
  assert.equal(new Set(seats).size, created);
  const state = await seatState(flightId);
  assert.equal(state.available, 50 - created);
  assertConsistent(state);
});

class Rollback extends Error {}

function lockTimedOut(error: unknown): boolean {
  return (error as { driverError?: { code?: string } }).driverError?.code === "55P03";
}

test("Test C2 — control: while one booking holds seat 1A, the next waits on it without SKIP LOCKED and takes 1B at once with it", async () => {
  const flightId = await createFlightWithSeats(50);
  const runner = createPostgresTransactionRunner(dataSource);
  const repository = createPostgresBookingRepository(dataSource);
  let claimed!: () => void;
  const holderClaimed = new Promise<void>((resolve) => (claimed = resolve));
  let release!: () => void;
  const holderReleased = new Promise<void>((resolve) => (release = resolve));

  const holder = runner
    .run(async () => {
      const result = await repository.holdSeats(flightId, crypto.randomUUID(), ONE_SEAT, NOW);
      assert.deepEqual(result, {
        outcome: "held",
        seats: [{ seat: "1A", fareClass: "ECONOMY", price: FIXTURE_FARES.ECONOMY }],
      });
      claimed();
      await holderReleased;
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  await holderClaimed;

  // Each claim below rolls back: no booking row is inserted for it, and the
  // deferred FK would refuse the commit anyway.
  async function claimWhileHeld(candidate: BookingRepository) {
    let outcome: unknown;
    await runner
      .run(async () => {
        await resolveEntityManager(dataSource).query(`SET LOCAL lock_timeout = '300ms'`);
        outcome = await candidate.holdSeats(flightId, crypto.randomUUID(), ONE_SEAT, NOW);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (error instanceof Rollback) return;
        outcome = lockTimedOut(error) ? "lock-timeout" : error;
      });
    return outcome;
  }

  try {
    assert.equal(await claimWhileHeld(createRepositoryWithoutSkipLocked()), "lock-timeout");
    assert.deepEqual(await claimWhileHeld(repository), {
      outcome: "held",
      seats: [{ seat: "1B", fareClass: "ECONOMY", price: FIXTURE_FARES.ECONOMY }],
    });
  } finally {
    release();
    await holder;
  }
});

const STAGGER_MS = [0, 1, 2, 4, 8];

test("Test D — on a full flight, a cancel racing a new booking never leaves two bookings on one seat", async (t) => {
  const createBooking = createCreateBookingUseCase();
  const cancelBooking = createCancelBookingUseCase();
  const tally = { rebooked: 0, soldOut: 0 };

  for (let round = 0; round < 20; round += 1) {
    const flightId = await createFlightWithSeats(5);
    const booked = await bookConcurrently(flightId, 5, createBooking);
    assert.equal(booked.created, 5);
    const [victim] = (await dataSource.query(
      `SELECT "id" FROM "bookings" WHERE "flight_id" = $1 LIMIT 1`,
      [flightId],
    )) as Array<{ id: string }>;
    assert.ok(victim);

    // Staggered start so both orders happen: the newcomer claiming while the
    // cancel still holds the seat row, and after it is released.
    const [cancelled, newcomer] = await Promise.all([
      cancelBooking(victim.id, OWNER_SCOPE, OWNER_ACTOR),
      sleep(STAGGER_MS[round % STAGGER_MS.length] ?? 0).then(() =>
        createBooking(flightId, { passengers: [{ name: "Newcomer" }] }, OWNER_ACTOR),
      ),
    ]);

    assert.equal(cancelled.outcome, "cancelled");
    assert.ok(
      newcomer.outcome === "created" || newcomer.outcome === "not-enough-seats",
      `unexpected outcome ${newcomer.outcome}`,
    );
    tally[newcomer.outcome === "created" ? "rebooked" : "soldOut"] += 1;

    const state = await seatState(flightId);
    assertConsistent(state);
    assert.equal(state.active, newcomer.outcome === "created" ? 5 : 4);
    assert.equal(state.available, newcomer.outcome === "created" ? 0 : 1);
  }

  t.diagnostic(`20 rounds: ${tally.rebooked} rebooked the released seat, ${tally.soldOut} sold-out`);
});

test("Test E — 10 concurrent cancels of one booking: 1 cancelled, 9 already-cancelled, the seat released once", async () => {
  const flightId = await createFlightWithSeats(1);
  assert.equal((await bookConcurrently(flightId, 1)).created, 1);
  const [booking] = (await dataSource.query(
    `SELECT "id" FROM "bookings" WHERE "flight_id" = $1`,
    [flightId],
  )) as Array<{ id: string }>;
  assert.ok(booking);
  const cancelBooking = createCancelBookingUseCase();

  const results = await Promise.all(
    Array.from({ length: 10 }, () => cancelBooking(booking.id, OWNER_SCOPE, OWNER_ACTOR)),
  );

  assert.equal(results.filter((r) => r.outcome === "cancelled").length, 1);
  assert.equal(results.filter((r) => r.outcome === "already-cancelled").length, 9);
  const state = await seatState(flightId);
  assert.equal(state.available, 1);
  assertConsistent(state);
});
