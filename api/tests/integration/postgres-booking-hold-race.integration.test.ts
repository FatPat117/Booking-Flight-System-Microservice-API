import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { formatSeatPosition } from "../../src/aircraft/seat-position.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import type { BookingRepository } from "../../src/bookings/booking-repository.js";
import {
  createCreateBooking,
  type CreateBookingResult,
} from "../../src/bookings/create-booking.js";
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
 * Multi-seat holds under real concurrency (Day 48A): separate pg Pool
 * connections (default max 10) running the real CreateBooking use case.
 * Day 47's postgres-booking-race file covers one seat per booking; this one
 * covers what only exists with several — all-or-nothing between competing
 * holds, lock order between chosen-seat requests, and reference clashes
 * between transactions that are both still open.
 */

const OWNER_ACTOR = { accountId: "11111111-1111-4111-8111-111111111111" };
const NOW = new Date("2026-07-20T00:00:00.000Z");

let dataSource: DataSource;

function createUseCase(
  options: {
    bookingRepository?: BookingRepository;
    generateReference?: () => string;
  } = {},
) {
  return createCreateBooking({
    bookingRepository:
      options.bookingRepository ?? createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateId: () => crypto.randomUUID(),
    generateReference: options.generateReference ?? nextBookingReference,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => NOW,
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

function auto(count: number) {
  return {
    passengers: Array.from({ length: count }, (_, i) => ({ name: `Passenger ${i + 1}` })),
  };
}

function chosen(...seats: string[]) {
  return { passengers: seats.map((seat, i) => ({ name: `Passenger ${i + 1}`, seat })) };
}

/**
 * The invariant every test ends on, read from the tables: the HELD seats are
 * exactly the seats of the HELD bookings' passengers — none extra (a
 * half-commit), none missing, none pointing at a booking that is not HELD.
 */
async function assertHoldsMatchPassengers(flightId: string) {
  const [state] = (await dataSource.query(
    `SELECT
       (SELECT count(*)::int FROM "flight_seats"
          WHERE "flight_id" = $1 AND "status" = 'HELD') AS "heldSeats",
       (SELECT count(*)::int FROM "booking_passengers" p
          JOIN "bookings" b ON b."id" = p."booking_id"
          WHERE b."flight_id" = $1 AND b."status" = 'HELD') AS "heldPassengers",
       (SELECT count(*)::int FROM "flight_seats" s
          LEFT JOIN "bookings" b ON b."id" = s."booking_id"
          WHERE s."flight_id" = $1 AND s."status" = 'HELD'
            AND (b."id" IS NULL OR b."status" <> 'HELD')) AS "orphaned",
       (SELECT count(*)::int FROM "booking_passengers" p
          JOIN "bookings" b ON b."id" = p."booking_id"
          LEFT JOIN "flight_seats" s ON s."booking_id" = p."booking_id"
            AND s."row" = p."seat_row" AND s."letter" = p."seat_letter"
          WHERE b."flight_id" = $1 AND b."status" = 'HELD'
            AND s."booking_id" IS NULL) AS "unmatchedCopies"`,
    [flightId],
  )) as Array<{
    heldSeats: number;
    heldPassengers: number;
    orphaned: number;
    unmatchedCopies: number;
  }>;
  assert.ok(state);
  assert.equal(state.heldSeats, state.heldPassengers, "HELD seats ≠ passengers of HELD bookings");
  assert.equal(state.orphaned, 0, "a HELD seat belongs to no HELD booking");
  assert.equal(state.unmatchedCopies, 0, "a passenger's seat copy is not HELD for the booking");
  return state;
}

async function availableSeats(flightId: string): Promise<number> {
  const [row] = (await dataSource.query(
    `SELECT count(*)::int AS "count" FROM "flight_seats"
     WHERE "flight_id" = $1 AND "status" = 'AVAILABLE'`,
    [flightId],
  )) as Array<{ count: number }>;
  return row?.count ?? 0;
}

function count(results: CreateBookingResult[], outcome: CreateBookingResult["outcome"]) {
  return results.filter((result) => result.outcome === outcome).length;
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

const ROUNDS = 20;

test("Test A — two 3-passenger bookings race for 4 seats: never both, never a partial hold", async (t) => {
  const createBooking = createUseCase();
  const tally = { one: 0, none: 0 };

  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight(4);

    const results = await Promise.all([
      createBooking(flightId, auto(3), OWNER_ACTOR),
      createBooking(flightId, auto(3), OWNER_ACTOR),
    ]);

    const created = count(results, "created");
    assert.equal(created + count(results, "not-enough-seats"), 2);
    assert.ok(created <= 1, "two 3-seat holds cannot both fit in 4 seats");
    tally[created === 1 ? "one" : "none"] += 1;

    const state = await assertHoldsMatchPassengers(flightId);
    assert.equal(state.heldSeats, 3 * created);
    assert.equal(await availableSeats(flightId), 4 - 3 * created);
  }

  // "none" would be a false not-enough-seats: each statement skipped rows the
  // other had just locked, so both saw fewer than 3. Recorded, not asserted.
  t.diagnostic(`${ROUNDS} rounds: ${tally.one} with one booking created, ${tally.none} with none`);
});

test("Test B — [12A, 12B] against [12B, 12A]: one created, one seats-unavailable, never a deadlock", async () => {
  const createBooking = createUseCase();

  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight();

    // A deadlock would surface as a rejected promise (40P01), failing here.
    const results = await Promise.all([
      createBooking(flightId, chosen("12A", "12B"), OWNER_ACTOR),
      createBooking(flightId, chosen("12B", "12A"), OWNER_ACTOR),
    ]);

    assert.equal(count(results, "created"), 1, JSON.stringify(results));
    const loser = results.find((result) => result.outcome !== "created");
    assert.equal(loser?.outcome, "seats-unavailable");
    await assertHoldsMatchPassengers(flightId);
    assert.equal(await availableSeats(flightId), 118);
  }
});

/**
 * Resolves once `parties` callers have arrived (the Day 46 barrier): forces
 * the interleaving instead of hoping timing produces it.
 */
function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const everyone = new Promise<void>((resolve) => {
    release = resolve;
  });

  return () => {
    arrived += 1;
    if (arrived === parties) {
      release();
    }
    return everyone;
  };
}

/**
 * Control for Test B — exists only here, never in src/. Locks the chosen
 * seats one statement at a time in the order the request lists them, then
 * holds them if all are free. `afterFirstLock` runs between the first lock
 * and the rest; with a barrier there, two requests for the same seats in
 * opposite orders each hold the seat the other wants next.
 */
function createRepositoryLockingInRequestOrder(
  afterFirstLock: () => Promise<void> = async () => {},
): BookingRepository {
  const repository = createPostgresBookingRepository(dataSource);
  return {
    ...repository,
    async holdSeats(flightId, bookingId, request, now) {
      assert.equal(request.kind, "chosen");
      if (request.kind !== "chosen") {
        return { outcome: "not-enough-seats" };
      }
      const manager = resolveEntityManager(dataSource);
      const statuses: string[] = [];
      for (const [index, seat] of request.seats.entries()) {
        const [row] = (await manager.query(
          `SELECT "status" FROM "flight_seats"
           WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3
           FOR UPDATE`,
          [flightId, seat.row, seat.letter],
        )) as Array<{ status: string }>;
        statuses.push(row?.status ?? "UNKNOWN");
        if (index === 0) {
          await afterFirstLock();
        }
      }
      const codes = request.seats.map(formatSeatPosition);
      if (statuses.some((status) => status !== "AVAILABLE")) {
        return {
          outcome: "seats-unavailable",
          seats: codes.filter((_, i) => statuses[i] !== "AVAILABLE"),
        };
      }
      await manager.query(
        `UPDATE "flight_seats" SET "status" = 'HELD', "booking_id" = $2
         WHERE "flight_id" = $1
           AND ("row", "letter"::text) IN (SELECT * FROM unnest($3::int[], $4::text[]))`,
        [flightId, bookingId, request.seats.map((s) => s.row), request.seats.map((s) => s.letter)],
      );
      return { outcome: "held", seats: codes };
    },
  };
}

async function raceOppositeOrders(createBooking: ReturnType<typeof createUseCase>) {
  const flightId = await createFlight();
  const settled = await Promise.allSettled([
    createBooking(flightId, chosen("12A", "12B"), OWNER_ACTOR),
    createBooking(flightId, chosen("12B", "12A"), OWNER_ACTOR),
  ]);
  await assertHoldsMatchPassengers(flightId);
  return settled;
}

test("Test C — control: locking in request order with both first locks taken deadlocks every time (40P01)", async () => {
  for (let round = 0; round < 10; round += 1) {
    const createBooking = createUseCase({
      bookingRepository: createRepositoryLockingInRequestOrder(createBarrier(2)),
    });

    const settled = await raceOppositeOrders(createBooking);

    // Postgres breaks the cycle by aborting one; the other then gets both seats.
    const rejected = settled.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 1, `round ${round}: expected exactly one deadlock victim`);
    assert.ok(isDeadlockDetected(rejected[0]?.reason), String(rejected[0]?.reason));
    const fulfilled = settled.find((result) => result.status === "fulfilled");
    assert.equal(fulfilled?.value.outcome, "created");
  }
});

test("Test C (measured) — the same control without a barrier: how often timing alone deadlocks", async (t) => {
  const createBooking = createUseCase({
    bookingRepository: createRepositoryLockingInRequestOrder(),
  });
  // Day 48A measured 98 of 100 rounds; each deadlock costs deadlock_timeout
  // (1 s), so the suite keeps 20.
  const tally = { deadlocks: 0, rounds: 20 };

  for (let round = 0; round < tally.rounds; round += 1) {
    const settled = await raceOppositeOrders(createBooking);
    tally.deadlocks += settled.filter(
      (result) => result.status === "rejected" && isDeadlockDetected(result.reason),
    ).length;
    for (const result of settled) {
      if (result.status === "rejected" && !isDeadlockDetected(result.reason)) {
        throw result.reason;
      }
    }
  }

  // Recorded only. Not rare at all: both requests start together, so each
  // usually takes its first seat before the other asks for it.
  t.diagnostic(`${tally.rounds} rounds without a barrier: ${tally.deadlocks} deadlocks`);
});

test("Test D — every concurrent booking draws the same reference first: all are created, each with its own reference", async () => {
  const flightId = await createFlight(50);
  const CALLERS = 10;
  const CLASH = "K7Q4PZ";

  // One use case per caller, so each one's first draw is the clash.
  const results = await Promise.all(
    Array.from({ length: CALLERS }, () => {
      let draws = 0;
      return createUseCase({
        generateReference: () => (draws++ === 0 ? CLASH : nextBookingReference()),
      })(flightId, auto(2), OWNER_ACTOR);
    }),
  );

  assert.equal(count(results, "created"), CALLERS);
  const references = results.flatMap((result) =>
    result.outcome === "created" ? [result.booking.reference] : [],
  );
  assert.equal(new Set(references).size, CALLERS);
  assert.equal(references.filter((reference) => reference === CLASH).length, 1);
  const state = await assertHoldsMatchPassengers(flightId);
  assert.equal(state.heldSeats, 2 * CALLERS);
});
