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
import { makeBooking as makeFixtureBooking } from "../fixtures/bookings.js";
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
/** Before the fixture holds lapse (2026-07-20T00:15Z), so cancel is allowed. */
const CANCEL_AT = new Date("2026-07-20T00:00:00.000Z");

const OWNER_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER: BookingAccessScope = { kind: "owner", accountId: OWNER_ACCOUNT_ID };

function makeBooking(flightId: string) {
  return makeFixtureBooking({ flightId, ownerAccountId: OWNER_ACCOUNT_ID });
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

const ONE_SEAT = { kind: "auto", count: 1 } as const;

test("holdSeats: the held seat row is HELD for that booking; the next call is not-enough-seats", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = await seedFlight(1);
  const booking = makeBooking(flight.id);

  const first = await createPostgresTransactionRunner(dataSource).run(async () => {
    const held = await bookingRepository.holdSeats(flight.id, booking.id, ONE_SEAT, NOW);
    await bookingRepository.create(booking);
    return held;
  });

  assert.deepEqual(first, { outcome: "held", seats: ["1A"] });
  assert.deepEqual(await seatRows(flight.id), [
    { seat: "1A", status: "HELD", booking_id: booking.id },
  ]);
  assert.deepEqual(
    await bookingRepository.holdSeats(flight.id, crypto.randomUUID(), ONE_SEAT, NOW),
    { outcome: "not-enough-seats" },
  );
});

test("holdSeats: a seat held for a booking that is never inserted fails at commit (deferred FK)", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = await seedFlight(1);

  // Outside a transaction the statement commits on its own, so the deferred
  // check runs at its end: the seat cannot point at a booking that never exists.
  await assert.rejects(
    bookingRepository.holdSeats(flight.id, crypto.randomUUID(), ONE_SEAT, NOW),
    { constraint: "FK_flight_seats_booking_id" },
  );
  assert.deepEqual(await seatRows(flight.id), [
    { seat: "1A", status: "AVAILABLE", booking_id: null },
  ]);
});

test("holdSeats: flight-not-found for an unknown flight id", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);

  const result = await bookingRepository.holdSeats(crypto.randomUUID(), crypto.randomUUID(), ONE_SEAT, NOW);
  assert.deepEqual(result, { outcome: "flight-not-found" });
});

// 🐞 The half-commit trap (Day 48A Step 4): an auto hold that finds fewer
// seats than asked must write nothing. The transaction below *commits* after
// the refusal, as CreateBooking's does — if the statement had updated the two
// seats it found and then reported not-enough-seats, they would stay HELD by
// a booking that is never created.
test("holdSeats: not-enough-seats inside a committing transaction leaves no seat HELD, none orphaned", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = await seedFlight(2);

  const result = await createPostgresTransactionRunner(dataSource).run(() =>
    bookingRepository.holdSeats(flight.id, crypto.randomUUID(), { kind: "auto", count: 3 }, NOW),
  );

  assert.deepEqual(result, { outcome: "not-enough-seats" });
  const [counts] = (await dataSource.query(
    `SELECT
       count(*) FILTER (WHERE s."status" = 'HELD')::int AS "held",
       count(*) FILTER (WHERE s."status" <> 'AVAILABLE' AND b."id" IS NULL)::int AS "orphaned"
     FROM "flight_seats" s LEFT JOIN "bookings" b ON b."id" = s."booking_id"
     WHERE s."flight_id" = $1`,
    [flight.id],
  )) as Array<{ held: number; orphaned: number }>;
  assert.deepEqual(counts, { held: 0, orphaned: 0 });
});

test("cancel: cancelled with flightId, its seat row back to AVAILABLE with no booking; then already-cancelled", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = await seedFlight(1);
  const booking = makeBooking(flight.id);
  await createPostgresTransactionRunner(dataSource).run(async () => {
    await bookingRepository.holdSeats(flight.id, booking.id, ONE_SEAT, NOW);
    await bookingRepository.create(booking);
  });

  const first = await bookingRepository.cancel(booking.id, OWNER, CANCEL_AT);
  assert.deepEqual(first, { outcome: "cancelled", flightId: flight.id });
  assert.deepEqual(await seatRows(flight.id), [
    { seat: "1A", status: "AVAILABLE", booking_id: null },
  ]);

  const second = await bookingRepository.cancel(booking.id, OWNER, CANCEL_AT);
  assert.deepEqual(second, { outcome: "already-cancelled" });
});

test("findPage reads a page in the same number of queries whatever its size (no query per booking)", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = await seedFlight(10);
  await createPostgresTransactionRunner(dataSource).run(async () => {
    for (let i = 0; i < 10; i += 1) {
      const booking = makeBooking(flight.id);
      await bookingRepository.holdSeats(flight.id, booking.id, ONE_SEAT, NOW);
      await bookingRepository.create(booking);
    }
  });

  // A second DataSource whose TypeORM logger counts every statement it sends.
  const queries: string[] = [];
  const counting = createBookingDataSource(parsePostgresConfig(process.env));
  counting.setOptions({
    logging: ["query"],
    logger: {
      logQuery: (query) => void queries.push(query),
      logQueryError: () => {},
      logQuerySlow: () => {},
      logSchemaBuild: () => {},
      logMigration: () => {},
      log: () => {},
    },
  });
  await counting.initialize();

  try {
    const repository = createPostgresBookingRepository(counting);
    const countFor = async (limit: number) => {
      queries.length = 0;
      const page = await repository.findPage({ kind: "admin" }, { limit, offset: 0 });
      assert.equal(page.items.length, limit);
      assert.ok(page.items.every((booking) => booking.passengers.length === 1));
      return [...queries];
    };

    const one = await countFor(1);
    const ten = await countFor(10);

    // count + page + one passenger lookup for the whole page (Day 48A
    // Step 0 measured the same 3 with the seat lookup it replaced).
    assert.equal(one.length, 3, one.join("\n---\n"));
    assert.equal(ten.length, one.length, ten.join("\n---\n"));
  } finally {
    await counting.destroy();
  }
});

test("cancel: not-found for an unknown booking id", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);

  const result = await bookingRepository.cancel(crypto.randomUUID(), OWNER, CANCEL_AT);
  assert.deepEqual(result, { outcome: "not-found" });
});

test("the expiry sweep's lookup reads idx_bookings_held_expiry in order, without a Sort", async () => {
  // Seq scans off, as in the outbox plan test: on a near-empty table the
  // planner's choice is a cost decision. This asserts the partial index can
  // serve the predicate *and* the ORDER BY, so a batch stops at LIMIT instead
  // of sorting every due hold (Day 48B Step 2 measured 104 vs 2 990 buffers
  // on 100 000 bookings).
  const rows = (await dataSource.transaction(async (manager) => {
    await manager.query("SET LOCAL enable_seqscan = off");
    return manager.query(
      `EXPLAIN SELECT "id" FROM "bookings"
       WHERE "status" = 'HELD' AND "hold_expires_at" <= $1
       ORDER BY "hold_expires_at", "id"
       LIMIT 50
       FOR UPDATE SKIP LOCKED`,
      [NOW],
    );
  })) as Array<Record<string, string>>;

  const planText = rows.map((row) => row["QUERY PLAN"]).join("\n");
  assert.match(planText, /idx_bookings_held_expiry/, planText);
  assert.doesNotMatch(planText, /Sort/, planText);
});

test("foreign key: a booking with an unknown flight_id is rejected by Postgres", async () => {
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const orphanBooking = makeBooking(crypto.randomUUID());

  await assert.rejects(() => bookingRepository.create(orphanBooking));

  const rows = await dataSource.query(`SELECT id FROM bookings`);
  assert.equal(rows.length, 0);
});
