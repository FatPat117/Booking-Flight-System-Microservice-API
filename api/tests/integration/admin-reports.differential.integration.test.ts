import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { DataSource } from "typeorm";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import type { ReportKey } from "../../src/reports/admin-reports.js";
import { createPostgresAdminReports } from "../../src/reports/postgres/postgres-admin-reports.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { Flight } from "../../src/types.js";
import { makeBooking, nextBookingReference, passengersFor } from "../fixtures/bookings.js";
import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_LONDON,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight,
  TEST_AIRCRAFT,
} from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { assertGlobalInvariants } from "./invariants.js";
import { occupySeats } from "./occupy-seats.js";

/**
 * Day 53 Step 4 — the verification matrix of the admin reports on Postgres.
 *
 * A  load factor against `naiveLoadFactor`, over seeded random worlds
 *    (replay one with REPORTS_SEED=<n>). The naive side imports nothing from
 *    src/: its own zone table, Intl for local dates, seats counted one by
 *    one from the world it built, not from the database.
 * B  every class of every flight adds up (checked on every compared page).
 * C  the manifest against the inventory, on bookings made through the real
 *    repository, with the global invariants holding underneath.
 * E  the audit log walked page by page through many equal timestamps.
 */

const SEEDS = Number(process.env.REPORTS_SEEDS ?? 30);
const ONLY_SEED = process.env.REPORTS_SEED === undefined ? undefined : Number(process.env.REPORTS_SEED);
const FLIGHTS_PER_WORLD = 18;
const QUERIES_PER_WORLD = 6;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ZONES: Readonly<Record<string, string>> = {
  ZZA: "Asia/Ho_Chi_Minh",
  ZZB: "Asia/Ho_Chi_Minh",
  ZZL: "Europe/London",
};
const PLACES = { ZZA: FIXTURE_ORIGIN, ZZB: FIXTURE_DESTINATION, ZZL: FIXTURE_LONDON } as const;
type Code = keyof typeof PLACES;
const ROUTES: ReadonlyArray<readonly [Code, Code]> = [["ZZA", "ZZB"], ["ZZB", "ZZA"], ["ZZL", "ZZA"], ["ZZA", "ZZL"]];
const AIRCRAFT = [FIXTURE_AIRCRAFT_ID, FIXTURE_OTHER_AIRCRAFT_ID, FIXTURE_TWO_CLASS_AIRCRAFT_ID];
const EPOCHS = [Date.UTC(2027, 2, 26), Date.UTC(2027, 9, 29), Date.UTC(2027, 5, 10)];

function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

after(async () => {
  await dataSource.destroy();
});

async function reset() {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE');
  await insertFlightReferences(dataSource);
}

// ---- A/B: load factor against a naive count ----

type SeatState = "free" | "booked" | "held" | "lapsed";
type WorldFlight = { flight: Flight; seats: Array<{ code: string; fareClass: string; state: SeatState }> };

function localDateOf(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(instant));
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

type Row = { id: string; status: string; classes: Array<[string, number, number, number, number]> };

/** The business definition: total, booked, held (valid hold), available (free or lapsed hold), per class. */
function naiveLoadFactor(world: readonly WorldFlight[], dateFrom: string, dateTo: string, origin: string | undefined): Row[] {
  return world
    .filter(({ flight }) => {
      const date = localDateOf(flight.departureAt, ZONES[flight.origin]!);
      return date >= dateFrom && date <= dateTo && (origin === undefined || flight.origin === origin);
    })
    .sort((a, b) => Date.parse(a.flight.departureAt) - Date.parse(b.flight.departureAt) || (a.flight.id < b.flight.id ? -1 : 1))
    .map(({ flight, seats }) => {
      const classes = new Map<string, [number, number, number, number]>();
      for (const seat of seats) {
        const counts = classes.get(seat.fareClass) ?? [0, 0, 0, 0];
        counts[0] += 1;
        if (seat.state === "booked") counts[1] += 1;
        else if (seat.state === "held") counts[2] += 1;
        else counts[3] += 1;
        classes.set(seat.fareClass, counts);
      }
      return {
        id: flight.id,
        status: flight.status,
        classes: [...classes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([fareClass, c]) => [fareClass, ...c]),
      };
    });
}

/** HELD seats owned by one booking whose hold ends at `holdExpiresAt`, straight in SQL (a fixture). */
async function holdInSql(flightId: string, codes: readonly string[], holdExpiresAt: Date) {
  if (codes.length === 0) return;
  const bookingId = crypto.randomUUID();
  const positions = codes.map((code) => parseSeatPosition(code)!);
  await dataSource.transaction(async (manager) => {
    await manager.query(
      `INSERT INTO "bookings" ("id", "flight_id", "created_at", "status", "owner_account_id", "hold_expires_at", "reference")
       VALUES ($1, $2, now(), 'HELD', '33333333-3333-4333-8333-333333333333', $3, $4)`,
      [bookingId, flightId, holdExpiresAt, nextBookingReference()],
    );
    await manager.query(
      `UPDATE "flight_seats" SET "status" = 'HELD', "booking_id" = $2
       WHERE "flight_id" = $1 AND ("row", "letter"::text) IN (SELECT * FROM unnest($3::int[], $4::text[]))`,
      [flightId, bookingId, positions.map((p) => p.row), positions.map((p) => p.letter)],
    );
  });
}

async function buildWorld(seed: number) {
  const random = prng(seed);
  const epoch = random.pick(EPOCHS);
  const now = new Date(epoch - 3 * DAY);
  await reset();
  const repository = createPostgresFlightRepository(dataSource);
  const world: WorldFlight[] = [];

  for (let index = 0; index < FLIGHTS_PER_WORLD; index += 1) {
    const [from, to] = random.pick(ROUTES);
    const aircraftId = random.pick(AIRCRAFT);
    // Near local midnights (17:00 UTC is midnight at +7; 23/00 UTC in London) half the time.
    const departure =
      random.next() < 0.5
        ? epoch + random.int(-1, 5) * DAY + random.pick([17, 23, 0]) * HOUR + random.int(-1, 1) * MINUTE
        : epoch + random.int(-1 * 24 * 60, 5 * 24 * 60) * MINUTE;
    const roll = random.next();
    const flight = makeFlight({
      aircraftId,
      originAirportId: PLACES[from].id,
      origin: from,
      destinationAirportId: PLACES[to].id,
      destination: to,
      departureAt: new Date(departure).toISOString(),
      arrivalAt: new Date(departure + random.int(60, 10 * 60) * MINUTE).toISOString(),
      status: roll < 0.7 ? "OPEN" : roll < 0.85 ? "SCHEDULED" : "CANCELLED",
    });
    if ((await repository.create(flight)).outcome !== "created") continue; // aircraft busy

    const seats = TEST_AIRCRAFT.find((aircraft) => aircraft.id === aircraftId)!.seats.map((seat) => {
      const r = random.next();
      const state: SeatState = r < 0.45 ? "free" : r < 0.75 ? "booked" : r < 0.9 ? "held" : "lapsed";
      return { code: `${seat.position.row}${seat.position.letter}`, fareClass: seat.fareClass, state };
    });
    await occupySeats(dataSource, flight.id, seats.filter((s) => s.state === "booked").map((s) => s.code));
    await holdInSql(flight.id, seats.filter((s) => s.state === "held").map((s) => s.code), new Date(now.getTime() + 10 * MINUTE));
    // Lapsed: the deadline passed, the expiry job has not swept it (Decision 12).
    await holdInSql(flight.id, seats.filter((s) => s.state === "lapsed").map((s) => s.code), new Date(now.getTime() - MINUTE));
    world.push({ flight, seats });
  }
  return { random, epoch, now, world };
}

test(`A/B — load factor, paged, equals a naive count over ${ONLY_SEED === undefined ? SEEDS : 1} random worlds, and every class adds up`, async () => {
  const reports = createPostgresAdminReports(dataSource);
  const seeds = ONLY_SEED === undefined ? Array.from({ length: SEEDS }, (_, index) => 5_000 + index) : [ONLY_SEED];
  let compared = 0;
  let nonEmpty = 0;

  for (const seed of seeds) {
    const { random, epoch, now, world } = await buildWorld(seed);
    for (let index = 0; index < QUERIES_PER_WORLD; index += 1) {
      const from = epoch + random.int(-1, 4) * DAY;
      const dateFrom = new Date(from).toISOString().slice(0, 10);
      const dateTo = new Date(from + random.int(0, 3) * DAY).toISOString().slice(0, 10);
      const origin = random.next() < 0.3 ? random.pick<Code>(["ZZA", "ZZB", "ZZL"]) : undefined;
      const limit = random.int(1, 7);
      const expected = naiveLoadFactor(world, dateFrom, dateTo, origin);

      const actual: Row[] = [];
      let after: ReportKey | undefined;
      for (let pages = 0; pages < 100; pages += 1) {
        const page = await reports.loadFactor(
          { dateFrom, dateTo, ...(origin === undefined ? {} : { origin }), limit, ...(after === undefined ? {} : { after }) },
          now,
        );
        for (const item of page.items) {
          for (const seats of item.classes) {
            assert.equal(seats.available + seats.held + seats.booked, seats.total, `B, seed ${seed}`);
          }
          actual.push({
            id: item.id,
            status: item.status,
            classes: item.classes.map((c) => [c.fareClass, c.total, c.booked, c.held, c.available]),
          });
        }
        const last = page.items.at(-1);
        if (!page.hasNextPage || last === undefined) break;
        after = { at: last.departureAt, id: last.id };
      }

      assert.deepEqual(actual, expected, `seed ${seed} (replay: REPORTS_SEED=${seed}), ${dateFrom}..${dateTo} ${origin ?? "all"} limit ${limit}`);
      compared += 1;
      if (expected.length > 0) nonEmpty += 1;
    }
  }
  assert.ok(nonEmpty >= compared / 2, `too many empty comparisons: ${nonEmpty} of ${compared}`);
});

// ---- C: manifest against the inventory ----

test("C — the manifest names exactly the passengers on BOOKED seats and counts what flight_seats holds, on real bookings, invariants holding", async () => {
  await reset();
  const random = prng(77);
  const now = new Date("2026-10-10T00:00:00.000Z");
  const flights = createPostgresFlightRepository(dataSource);
  const bookings = createPostgresBookingRepository(dataSource);
  const transactions = createPostgresTransactionRunner(dataSource);
  const reports = createPostgresAdminReports(dataSource);
  const layout = TEST_AIRCRAFT.find((aircraft) => aircraft.id === FIXTURE_TWO_CLASS_AIRCRAFT_ID)!.seats;

  for (let index = 0; index < 4; index += 1) {
    const flight = makeFlight({ aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID });
    await flights.create(flight);
    const free = layout.map((seat) => `${seat.position.row}${seat.position.letter}`).sort(() => random.next() - 0.5);

    for (let made = 0; made < 8 && free.length > 0; made += 1) {
      const codes = free.splice(0, random.int(1, 3));
      const lapsed = random.next() < 0.2;
      const booking = makeBooking({
        flightId: flight.id,
        holdExpiresAt: new Date(now.getTime() + (lapsed ? -MINUTE : 15 * MINUTE)).toISOString(),
      });
      await transactions.run(async () => {
        const held = await bookings.holdSeats(
          flight.id,
          booking.id,
          { kind: "chosen", seats: codes.map((code) => parseSeatPosition(code)!) },
          new Date(now.getTime() - 20 * MINUTE),
        );
        if (held.outcome !== "held") throw new Error(held.outcome);
        await bookings.create({ ...booking, passengers: passengersFor(held.seats) });
      });
      if (lapsed) continue;
      const fate = random.next();
      if (fate < 0.6) {
        assert.equal((await bookings.confirmHold(booking.id, { kind: "admin" }, now)).outcome, "confirmed");
        if (random.next() < 0.25) {
          assert.equal(
            (await transactions.run(() => bookings.cancel(booking.id, { kind: "admin" }, now, "CUSTOMER"))).outcome,
            "cancelled",
          );
        }
      }
    }

    const manifest = await reports.findManifest(flight.id, now);
    assert.ok(manifest);
    const inventory = (await dataSource.query(
      `SELECT s."row" || s."letter" AS "seat", s."fare_class" AS "fareClass", s."status", b."hold_expires_at" > $2 AS "valid"
       FROM "flight_seats" s LEFT JOIN "bookings" b ON b."id" = s."booking_id"
       WHERE s."flight_id" = $1`,
      [flight.id, now],
    )) as Array<{ seat: string; fareClass: string; status: string; valid: boolean | null }>;

    const bookedSeats = inventory.filter((seat) => seat.status === "BOOKED").map((seat) => seat.seat).sort();
    assert.deepEqual(manifest.passengers.map((passenger) => passenger.seat).sort(), bookedSeats);
    for (const fareClass of ["BUSINESS", "ECONOMY"]) {
      const ofClass = inventory.filter((seat) => seat.fareClass === fareClass);
      assert.deepEqual(manifest.classes.find((seats) => seats.fareClass === fareClass), {
        fareClass,
        total: ofClass.length,
        booked: ofClass.filter((seat) => seat.status === "BOOKED").length,
        held: ofClass.filter((seat) => seat.status === "HELD" && seat.valid === true).length,
        available: ofClass.filter((seat) => seat.status === "AVAILABLE" || (seat.status === "HELD" && seat.valid === false)).length,
      });
    }
  }
  await assertGlobalInvariants(dataSource);
});

// ---- E: audit pages ----

test("E — the audit log walked page by page returns every entry once, newest first, through equal timestamps, for a target and for a range", async () => {
  await reset();
  const reports = createPostgresAdminReports(dataSource);
  const target = crypto.randomUUID();
  // 240 entries on only 12 distinct instants: ties everywhere.
  await dataSource.query(
    `INSERT INTO "audit_logs" ("id", "action", "actor_type", "actor_id", "target_type", "target_id", "occurred_at", "metadata")
     SELECT gen_random_uuid(), 'BOOKING_SEAT_CHANGED', 'system', 'test',
            'booking', CASE WHEN n % 3 = 0 THEN $1 ELSE gen_random_uuid()::text END,
            timestamptz '2026-09-01T00:00:00Z' + (n % 12) * interval '1 hour', '{}'
     FROM generate_series(1, 240) AS n`,
    [target],
  );
  const all = (await dataSource.query(
    `SELECT "id", "target_id" AS "target", "occurred_at" AS "at" FROM "audit_logs"`,
  )) as Array<{ id: string; target: string; at: Date }>;
  const newestFirst = (rows: typeof all) =>
    [...rows].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1)).map((row) => row.id);

  const walk = async (query: { target?: { type: string; id: string }; range?: { from: string; to: string } }, limit: number) => {
    const ids: string[] = [];
    let after: ReportKey | undefined;
    for (;;) {
      const page = await reports.auditLog({ ...query, limit, ...(after === undefined ? {} : { after }) });
      ids.push(...page.items.map((item) => item.id));
      const last = page.items.at(-1);
      if (!page.hasNextPage || last === undefined) return ids;
      after = { at: last.occurredAt, id: last.id };
    }
  };

  for (const limit of [1, 7, 50, 100]) {
    const byTarget = await walk({ target: { type: "booking", id: target } }, limit);
    assert.deepEqual(byTarget, newestFirst(all.filter((row) => row.target === target)), `target, limit ${limit}`);
    const range = { from: "2026-09-01T02:00:00.000Z", to: "2026-09-01T09:00:00.000Z" };
    const byRange = await walk({ range }, limit);
    assert.deepEqual(
      byRange,
      newestFirst(all.filter((row) => row.at.getTime() >= Date.parse(range.from) && row.at.getTime() < Date.parse(range.to))),
      `range, limit ${limit}`,
    );
    assert.equal(new Set(byRange).size, byRange.length, "no entry twice");
  }
});
