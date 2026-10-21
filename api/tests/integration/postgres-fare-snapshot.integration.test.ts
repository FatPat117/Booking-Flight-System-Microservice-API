import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import type { AuditRecorder } from "../../src/audit/audit-recorder.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { formatSeatPosition } from "../../src/aircraft/seat-position.js";
import type { FareClass } from "../../src/aircraft/seat-layout.js";
import type {
  Booking,
  BookingRepository,
  HoldSeatsResult,
} from "../../src/bookings/booking-repository.js";
import {
  createCreateBooking,
  type CreateBookingResult,
} from "../../src/bookings/create-booking.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parseVndFromDatabase } from "../../src/money/money.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { resolveEntityManager } from "../../src/postgres/transaction-context.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { FIXTURE_TWO_CLASS_AIRCRAFT_ID, makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * The price snapshot under real concurrency (Day 49A, Decision 13,
 * BR-BOOK-03): a hold copies each seat's fare in the statement that holds
 * it, with the flight's fare rows share-locked. Separate pg Pool connections
 * run the real CreateBooking. The fake cannot fail any of this — row locks,
 * READ COMMITTED re-reading a row it waited for, and statement snapshots are
 * Postgres semantics.
 *
 * Every flight here is on the two-class fixture aircraft: rows 1–2 BUSINESS,
 * 3–5 ECONOMY, fares 4 200 000 and 1 500 000 until a test changes them.
 */

const OWNER = { accountId: "11111111-1111-4111-8111-111111111111" };
const NOW = new Date("2026-07-20T00:00:00.000Z");
/** Long enough for a statement to reach its lock and queue there. */
const QUEUE_MS = 50;

let dataSource: DataSource;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBooking(
  options: { bookingRepository?: BookingRepository; auditRecorder?: AuditRecorder } = {},
) {
  return createCreateBooking({
    bookingRepository: options.bookingRepository ?? createPostgresBookingRepository(dataSource),
    auditRecorder: options.auditRecorder ?? createPostgresAuditRecorder(dataSource),
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

async function createFlight(): Promise<string> {
  const flight = makeFlight({ aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID });
  await createPostgresFlightRepository(dataSource).create(flight);
  return flight.id;
}

/** One BUSINESS and one ECONOMY seat: a hold that needs both fares. */
function businessAndEconomy(business: string, economy: string) {
  return {
    passengers: [
      { name: "Alice", seat: business },
      { name: "Bob", seat: economy },
    ],
  };
}

function bookedOrFail(result: CreateBookingResult): Booking {
  assert.equal(result.outcome, "created", JSON.stringify(result));
  return (result as { booking: Booking }).booking;
}

/** "BUSINESS 4200000, ECONOMY 1500000 = 5700000" — one line to compare. */
function priced(booking: Booking | undefined): string {
  assert.ok(booking);
  const prices = booking.passengers
    .map(({ fareClass, price }) => `${fareClass} ${price?.amount}`)
    .join(", ");
  return `${prices} = ${booking.total.amount}`;
}

const SQL_SET_FARES = `UPDATE "flight_fares"
  SET "amount_vnd" = CASE "fare_class" WHEN 'BUSINESS' THEN $2::bigint ELSE $3::bigint END
  WHERE "flight_id" = $1`;

/** Changes both fares in one committed transaction. */
async function setFares(flightId: string, business: number, economy: number) {
  await dataSource.query(SQL_SET_FARES, [flightId, business, economy]);
}

/**
 * Changes both fares in a transaction of its own and keeps it open until
 * the returned function commits it: a fare change "in progress".
 */
async function startFareChange(
  flightId: string,
  business: number,
  economy: number,
): Promise<() => Promise<void>> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  await runner.query(SQL_SET_FARES, [flightId, business, economy]);
  return async () => {
    await runner.commitTransaction();
    await runner.release();
  };
}

/** Whether `promise` is still pending after `ms` — "it queued on a lock". */
async function isPendingAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const pending = Symbol("pending");
  const winner = await Promise.race([promise.then(() => undefined), sleep(ms).then(() => pending)]);
  return winner === pending;
}

async function readBooking(bookingId: string): Promise<Booking | undefined> {
  return createPostgresBookingRepository(dataSource).findById(bookingId, { kind: "admin" });
}

/**
 * Control for Test B — exists only here, never in src/. The real
 * chosen-seat statement with one change: the fares CTE has no `FOR SHARE`.
 * It still prices every seat from one snapshot; it just neither waits for a
 * fare change in progress nor makes one wait.
 */
function createRepositoryWithoutFareLock(): BookingRepository {
  const repository = createPostgresBookingRepository(dataSource);
  return {
    ...repository,
    async holdSeats(flightId, bookingId, request): Promise<HoldSeatsResult> {
      assert.equal(request.kind, "chosen");
      if (request.kind !== "chosen") {
        return { outcome: "not-enough-seats" };
      }
      const rows = (await resolveEntityManager(dataSource).query(
        `WITH locked AS (
           SELECT seat."row", seat."letter"::text AS "letter", seat."fare_class"
           FROM "flight_seats" seat
           WHERE seat."flight_id" = $1 AND seat."status" = 'AVAILABLE'
             AND (seat."row", seat."letter"::text) IN (SELECT * FROM unnest($2::int[], $3::text[]))
           ORDER BY seat."row", seat."letter"
           FOR UPDATE OF seat
         ), held AS (
           UPDATE "flight_seats" seat SET "status" = 'HELD', "booking_id" = $4
           FROM locked
           WHERE seat."flight_id" = $1 AND seat."row" = locked."row" AND seat."letter" = locked."letter"
           RETURNING seat."row"
         ), fares AS (
           SELECT "fare_class", "amount_vnd" FROM "flight_fares" WHERE "flight_id" = $1
         )
         SELECT locked."row", locked."letter", locked."fare_class", fares."amount_vnd",
                (SELECT count(*) FROM held)::int AS "held"
         FROM locked LEFT JOIN fares ON fares."fare_class" = locked."fare_class"`,
        [
          flightId,
          request.seats.map(({ row }) => row),
          request.seats.map(({ letter }) => letter),
          bookingId,
        ],
      )) as Array<{ row: number; letter: string; fare_class: string; amount_vnd: string }>;
      assert.equal(rows.length, request.seats.length, "the control expects free seats");
      const byCode = new Map(rows.map((row) => [formatSeatPosition(row), row]));
      return {
        outcome: "held",
        seats: request.seats.map((position) => {
          const row = byCode.get(formatSeatPosition(position));
          assert.ok(row);
          return {
            seat: formatSeatPosition(position),
            fareClass: row.fare_class as FareClass,
            price: parseVndFromDatabase(row.amount_vnd),
          };
        }),
      };
    },
  };
}

/**
 * An audit recorder that holds CreateBooking's transaction open after the
 * hold statement until `release` is called: "the hold is done, its
 * transaction has not committed yet".
 */
function pausingAuditRecorder() {
  let reached!: () => void;
  const atAudit = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const audit = createPostgresAuditRecorder(dataSource);
  const auditRecorder: AuditRecorder = {
    async record(input) {
      reached();
      await released;
      await audit.record(input);
    },
  };
  return { auditRecorder, atAudit, release };
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

// ---- A: the snapshot does not move ----

test("Test A — a fare change after the hold leaves the booking's prices and total alone; the next booking pays the new fares", async () => {
  const flightId = await createFlight();
  const first = bookedOrFail(await createBooking()(flightId, businessAndEconomy("1A", "3A"), OWNER));

  await setFares(flightId, 5_000_000, 2_000_000);
  const second = bookedOrFail(await createBooking()(flightId, businessAndEconomy("1B", "3B"), OWNER));

  assert.equal(priced(await readBooking(first.id)), "BUSINESS 4200000, ECONOMY 1500000 = 5700000");
  assert.equal(priced(await readBooking(second.id)), "BUSINESS 5000000, ECONOMY 2000000 = 7000000");
  // The flight shows the new fares, read back as numbers.
  const flight = await createPostgresFlightRepository(dataSource).findById(flightId);
  assert.deepEqual(
    [flight?.fares.BUSINESS?.amount, flight?.fares.ECONOMY?.amount],
    [5_000_000, 2_000_000],
  );
});

test("Test A — a seat whose class has no fare (BR-FLT-09 broken by hand) makes the hold throw, and nothing is held or stored", async () => {
  const flightId = await createFlight();
  await dataSource.query(
    `DELETE FROM "flight_fares" WHERE "flight_id" = $1 AND "fare_class" = 'BUSINESS'`,
    [flightId],
  );

  await assert.rejects(
    () => createBooking()(flightId, businessAndEconomy("1A", "3A"), OWNER),
    /no BUSINESS fare for seat 1A \(BR-FLT-09\)/,
  );
  const [state] = (await dataSource.query(
    `SELECT (SELECT count(*)::int FROM "flight_seats" WHERE "flight_id" = $1 AND "status" <> 'AVAILABLE') AS "taken",
            (SELECT count(*)::int FROM "bookings") AS "bookings"`,
    [flightId],
  )) as Array<{ taken: number; bookings: number }>;
  assert.deepEqual(state, { taken: 0, bookings: 0 });
});

// ---- B: the fare rows are locked by the hold statement ----

test("Test B1 — a hold arriving during an uncommitted fare change waits for it, then takes the new fares for both classes", async () => {
  const flightId = await createFlight();
  const commitChange = await startFareChange(flightId, 5_000_000, 2_000_000);

  const booking = createBooking()(flightId, businessAndEconomy("1A", "3A"), OWNER);
  const waited = await isPendingAfter(booking, QUEUE_MS);
  await commitChange();
  const held = bookedOrFail(await booking);

  assert.equal(waited, true, "the hold should queue on the fare rows");
  assert.equal(priced(await readBooking(held.id)), "BUSINESS 5000000, ECONOMY 2000000 = 7000000");
});

test("Test B1 (auto) — a system-picked hold waits the same way: its own statement locks the fares too", async () => {
  const flightId = await createFlight();
  const commitChange = await startFareChange(flightId, 5_000_000, 2_000_000);

  const booking = createBooking()(flightId, { passengers: [{ name: "Alice" }, { name: "Bob" }] }, OWNER);
  const waited = await isPendingAfter(booking, QUEUE_MS);
  await commitChange();
  const held = bookedOrFail(await booking);

  assert.equal(waited, true, "the hold should queue on the fare rows");
  // Lowest seats first: 1A and 1B are BUSINESS.
  assert.equal(priced(await readBooking(held.id)), "BUSINESS 5000000, BUSINESS 5000000 = 10000000");
});

test("Test B1 — control without FOR SHARE: the hold does not wait and takes the old fares while the change is in progress", async () => {
  const flightId = await createFlight();
  const commitChange = await startFareChange(flightId, 5_000_000, 2_000_000);

  const booking = createBooking({ bookingRepository: createRepositoryWithoutFareLock() })(
    flightId,
    businessAndEconomy("1A", "3A"),
    OWNER,
  );
  const waited = await isPendingAfter(booking, QUEUE_MS);
  const held = bookedOrFail(await booking);
  await commitChange();

  assert.equal(waited, false);
  assert.equal(priced(await readBooking(held.id)), "BUSINESS 4200000, ECONOMY 1500000 = 5700000");
});

test("Test B2 — a fare change during a hold's open transaction waits for it to commit: the booking never outlives the old fare", async () => {
  const flightId = await createFlight();
  const pause = pausingAuditRecorder();
  const booking = createBooking({ auditRecorder: pause.auditRecorder })(
    flightId,
    businessAndEconomy("1A", "3A"),
    OWNER,
  );
  await pause.atAudit; // the hold statement ran; its transaction is open

  const change = setFares(flightId, 5_000_000, 2_000_000);
  const changeWaited = await isPendingAfter(change, QUEUE_MS);
  pause.release();
  const held = bookedOrFail(await booking);
  await change;

  assert.equal(changeWaited, true, "the fare change should queue behind the hold");
  // Old fares, committed before the change: a consistent order.
  assert.equal(priced(await readBooking(held.id)), "BUSINESS 4200000, ECONOMY 1500000 = 5700000");
});

test("Test B2 — control without FOR SHARE: the fare change commits mid-hold, and the booking commits after it with the old fares", async () => {
  const flightId = await createFlight();
  const pause = pausingAuditRecorder();
  const booking = createBooking({
    bookingRepository: createRepositoryWithoutFareLock(),
    auditRecorder: pause.auditRecorder,
  })(flightId, businessAndEconomy("1A", "3A"), OWNER);
  await pause.atAudit;

  const change = setFares(flightId, 5_000_000, 2_000_000);
  const changeWaited = await isPendingAfter(change, QUEUE_MS);
  await change; // committed: the new fares are in effect
  pause.release();
  const held = bookedOrFail(await booking);

  assert.equal(changeWaited, false);
  // Committed after the new fares took effect, yet priced at the old ones.
  assert.equal(priced(await readBooking(held.id)), "BUSINESS 4200000, ECONOMY 1500000 = 5700000");
});

// ---- C: no mixed versions under unforced timing ----

const STAGGER_MS = [0, 2, 5, 10, 20];

test("Test C — 20 rounds of two holds racing a fare change: every booking pays one version of the fares, never one class old and one new", async (t) => {
  const tally = { old: 0, new: 0 };

  for (let round = 0; round < 20; round += 1) {
    const flightId = await createFlight();
    // Staggered so the change lands before, between and after the holds.
    const results = await Promise.all([
      createBooking()(flightId, businessAndEconomy("1A", "3A"), OWNER),
      sleep(STAGGER_MS[round % STAGGER_MS.length] as number)
        .then(() => setFares(flightId, 5_000_000, 2_000_000))
        .then(() => undefined),
      createBooking()(flightId, businessAndEconomy("1B", "3B"), OWNER),
    ]);

    for (const result of [results[0], results[2]]) {
      const line = priced(await readBooking(bookedOrFail(result as CreateBookingResult).id));
      assert.ok(
        line === "BUSINESS 4200000, ECONOMY 1500000 = 5700000" ||
          line === "BUSINESS 5000000, ECONOMY 2000000 = 7000000",
        line,
      );
      tally[line.startsWith("BUSINESS 4200000") ? "old" : "new"] += 1;
    }
  }

  t.diagnostic(`40 bookings: ${tally.old} at the old fares, ${tally.new} at the new`);
});
