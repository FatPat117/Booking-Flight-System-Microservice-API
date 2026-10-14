import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { DataSource } from "typeorm";

import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { Flight } from "../../src/types.js";
import { runFlightRepositoryContract } from "../contracts/flight-repository.contract.js";
import {
  FIXTURE_OTHER_AIRCRAFT_ID,
  makeFlight as makeFixtureFlight,
} from "../fixtures/flights.js";
import { failSeatInserts } from "./failing-seat-inserts.js";
import { insertFlightReferences, keepFirstSeats } from "./flight-references.js";

/**
 * Runs against the real booking_db Postgres container — not a fake, not
 * SQLite. Requires `docker compose up postgres` first (see Dev.md). Split
 * from `npm test` (tests/*.test.ts) into its own script precisely because
 * Day 35 found zero tests in this repo hit a real database; this is the
 * first one, and it must not silently break `npm test` on a machine with
 * no Postgres running.
 */

let dataSource: DataSource;

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return makeFixtureFlight({ flightNumber: "VN123", availableSeats: 120, ...overrides });
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "flights" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

test("create then findById round-trips a Flight as ISO date strings, not Date objects", async () => {
  const repository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight();

  const created = await repository.create(flight);
  assert.equal(created.outcome, "created");

  const found = await repository.findById(flight.id);
  assert.deepEqual(found, flight);
  assert.equal(typeof found?.departureAt, "string");
  assert.equal(typeof found?.arrivalAt, "string");
});

test("duplicate flightNumber+departureAt is rejected by Postgres's unique constraint and returns duplicate", async () => {
  const repository = createPostgresFlightRepository(dataSource);
  const first = makeFlight();
  // Another aircraft, so the exclusion constraint cannot fire first.
  const second = makeFlight({
    id: crypto.randomUUID(),
    flightNumber: first.flightNumber,
    departureAt: first.departureAt,
    arrivalAt: first.arrivalAt,
    aircraftId: FIXTURE_OTHER_AIRCRAFT_ID,
  });

  assert.equal((await repository.create(first)).outcome, "created");
  assert.equal((await repository.create(second)).outcome, "duplicate");

  const page = await repository.findPage({ limit: 20, offset: 0 });
  assert.equal(page.totalItems, 1);
});

test("findPage orders by departureAt ascending and respects limit/offset", async () => {
  const repository = createPostgresFlightRepository(dataSource);

  const later = makeFlight({
    id: crypto.randomUUID(),
    flightNumber: "VN201",
    departureAt: "2026-09-01T01:00:00.000Z",
    arrivalAt: "2026-09-01T03:00:00.000Z",
  });
  const earlier = makeFlight({
    id: crypto.randomUUID(),
    flightNumber: "VN101",
    departureAt: "2026-08-01T01:00:00.000Z",
    arrivalAt: "2026-08-01T03:00:00.000Z",
  });

  await repository.create(later);
  await repository.create(earlier);

  const firstPage = await repository.findPage({ limit: 1, offset: 0 });
  assert.equal(firstPage.totalItems, 2);
  assert.equal(firstPage.items[0]?.id, earlier.id);

  const secondPage = await repository.findPage({ limit: 1, offset: 1 });
  assert.equal(secondPage.items[0]?.id, later.id);
});

test("findById returns undefined for an unknown id", async () => {
  const repository = createPostgresFlightRepository(dataSource);

  const found = await repository.findById(crypto.randomUUID());
  assert.equal(found, undefined);
});

test("an aircraft id that does not exist is reference-not-found (FK, 23503), not a crash", async () => {
  const repository = createPostgresFlightRepository(dataSource);

  assert.deepEqual(
    await repository.create(makeFlight({ aircraftId: crypto.randomUUID() })),
    { outcome: "reference-not-found" },
  );
});

test("the exclusion violation surfaces as SQLSTATE 23P01 on the named constraint", async () => {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);

  await assert.rejects(
    dataSource.query(
      `INSERT INTO flights (id, flight_number, origin_airport_id, destination_airport_id,
         aircraft_id, departure_at, arrival_at, price_in_cents, currency, status)
       SELECT gen_random_uuid(), 'VN999', origin_airport_id, destination_airport_id,
         aircraft_id, departure_at + interval '1 hour', arrival_at + interval '1 hour',
         price_in_cents, currency, 'SCHEDULED'
       FROM flights WHERE id = $1`,
      [flight.id],
    ),
    { code: "23P01", constraint: "EXCL_flights_aircraft_schedule" },
  );
});

test("a deadlock between two concurrent overlapping inserts is aircraft-unavailable (40P01), not a crash", async () => {
  const repository = createPostgresFlightRepository(dataSource);
  const transactionRunner = createPostgresTransactionRunner(dataSource);
  // Occupancy windows (arrival + 45 min): X [08:00, 09:45), Y [09:30, 11:15),
  // Z [11:00, 12:45). Y overlaps X and Z; X and Z do not overlap.
  const at = (time: string) => `2027-03-01T${time}:00.000Z`;
  const x = makeFlight({ flightNumber: "VN801", departureAt: at("08:00"), arrivalAt: at("09:00") });
  const y = makeFlight({ flightNumber: "VN802", departureAt: at("09:30"), arrivalAt: at("10:30") });
  const z = makeFlight({ flightNumber: "VN803", departureAt: at("11:00"), arrivalAt: at("12:00") });

  let xInserted: () => void = () => {};
  const xIsInserted = new Promise<void>((resolve) => {
    xInserted = resolve;
  });

  // T1 holds X uncommitted; T2's Y waits on X; then T1's Z waits on Y — a
  // cycle Postgres breaks by aborting one of the two with 40P01.
  const [first, second] = await Promise.all([
    transactionRunner.run(async () => {
      const results = [await repository.create(x)];
      xInserted();
      await sleep(300);
      results.push(await repository.create(z));
      return results;
    }),
    transactionRunner.run(async () => {
      await xIsInserted;
      return [await repository.create(y)];
    }),
  ]);

  const outcomes = [...first, ...second].map((result) => result.outcome);
  assert.ok(
    outcomes.includes("aircraft-unavailable"),
    `expected the deadlock victim to be aircraft-unavailable, got ${outcomes.join(", ")}`,
  );
  assert.ok(outcomes.every((outcome) => outcome === "created" || outcome === "aircraft-unavailable"));
});

test("create copies the aircraft's layout into flight_seats: every seat, AVAILABLE, no booking", async () => {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);

  // Position by position against the aircraft's seats, both directions.
  const [diff] = (await dataSource.query(
    `SELECT
       (SELECT count(*) FROM (
          SELECT "row", "letter", "fare_class" FROM "seats" WHERE "aircraft_id" = $2
          EXCEPT
          SELECT "row", "letter", "fare_class" FROM "flight_seats" WHERE "flight_id" = $1
        ) missing)::int AS missing,
       (SELECT count(*) FROM (
          SELECT "row", "letter", "fare_class" FROM "flight_seats" WHERE "flight_id" = $1
          EXCEPT
          SELECT "row", "letter", "fare_class" FROM "seats" WHERE "aircraft_id" = $2
        ) extra)::int AS extra,
       (SELECT count(*) FROM "flight_seats"
        WHERE "flight_id" = $1 AND ("status" <> 'AVAILABLE' OR "booking_id" IS NOT NULL))::int AS taken`,
    [flight.id, flight.aircraftId],
  )) as { missing: number; extra: number; taken: number }[];

  assert.deepEqual(diff, { missing: 0, extra: 0, taken: 0 });
  assert.equal((await createPostgresFlightRepository(dataSource).findById(flight.id))?.availableSeats, 120);
});

test("outside a transaction, a failing seat insert leaves no flight behind (create opens its own)", async () => {
  const restore = await failSeatInserts(dataSource);
  try {
    await assert.rejects(
      createPostgresFlightRepository(dataSource).create(makeFlight()),
      /seat insert failed/,
    );
  } finally {
    await restore();
  }

  const [counts] = (await dataSource.query(
    `SELECT (SELECT count(*) FROM "flights")::int AS flights,
            (SELECT count(*) FROM "flight_seats")::int AS seats`,
  )) as { flights: number; seats: number }[];
  assert.deepEqual(counts, { flights: 0, seats: 0 });
});

test("findPage keeps a sold-out flight and a flight with no seats at all, counting 0, never dropping them", async () => {
  const repository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const soldOut = makeFlight({ flightNumber: "VN301" });
  const seatless = makeFlight({ flightNumber: "VN302" });
  const roomy = makeFlight({ flightNumber: "VN303" });
  for (const flight of [soldOut, seatless, roomy]) {
    await repository.create(flight);
  }
  await keepFirstSeats(dataSource, soldOut.id, 1);
  await keepFirstSeats(dataSource, seatless.id, 0);
  const booking = {
    id: crypto.randomUUID(),
    flightId: soldOut.id,
    ownerAccountId: "11111111-1111-4111-8111-111111111111",
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active" as const,
    seat: null,
  };
  await createPostgresTransactionRunner(dataSource).run(async () => {
    await bookingRepository.reserveSeat(soldOut.id, booking.id, new Date("2026-07-20T00:00:00.000Z"));
    await bookingRepository.create(booking);
  });

  const page = await repository.findPage({ limit: 20, offset: 0 });

  assert.equal(page.totalItems, 3);
  assert.deepEqual(
    page.items.map((flight) => [flight.flightNumber, flight.availableSeats]),
    [["VN301", 0], ["VN302", 0], ["VN303", 120]],
  );
  assert.equal((await repository.findById(soldOut.id))?.availableSeats, 0);
  assert.deepEqual(await repository.findSeats(seatless.id), []);
});

test("findSeats reports a claimed seat as BOOKED", async () => {
  const repository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight();
  await repository.create(flight);
  const booking = {
    id: crypto.randomUUID(),
    flightId: flight.id,
    ownerAccountId: "11111111-1111-4111-8111-111111111111",
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active" as const,
    seat: null,
  };
  await createPostgresTransactionRunner(dataSource).run(async () => {
    await bookingRepository.reserveSeat(flight.id, booking.id, new Date("2026-07-20T00:00:00.000Z"));
    await bookingRepository.create(booking);
  });

  const seats = await repository.findSeats(flight.id);

  assert.deepEqual(seats?.slice(0, 2), [
    { position: { row: 1, letter: "A" }, fareClass: "ECONOMY", status: "BOOKED" },
    { position: { row: 1, letter: "B" }, fareClass: "ECONOMY", status: "AVAILABLE" },
  ]);
});

runFlightRepositoryContract("postgres", async () =>
  createPostgresFlightRepository(dataSource),
);
