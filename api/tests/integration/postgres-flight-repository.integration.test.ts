import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import type { Flight } from "../../src/types.js";

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
  return {
    id: crypto.randomUUID(),
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T01:00:00.000Z",
    arrivalAt: "2026-08-10T03:00:00.000Z",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 120,
    ...overrides,
  };
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "flights"');
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
  const second = makeFlight({
    id: crypto.randomUUID(),
    flightNumber: first.flightNumber,
    departureAt: first.departureAt,
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
