import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import type { Aircraft } from "../../src/aircraft/aircraft-repository.js";
import { createPostgresAircraftRepository } from "../../src/aircraft/postgres/postgres-aircraft-repository.js";
import { expandSeatLayout } from "../../src/aircraft/seat-layout.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";

/**
 * Database semantics only Postgres can prove (ADR-005): an aircraft is never
 * stored without its seats. Counted with raw SQL, not through the
 * repository, so a repository bug cannot hide a leftover row.
 */

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  // CASCADE: flights reference aircraft since Day 46.
  await dataSource.query('TRUNCATE TABLE "seats", "aircraft" CASCADE');
});

after(async () => {
  await dataSource.destroy();
});

function makeAircraft(): Aircraft {
  const layout = expandSeatLayout({
    cabins: [
      { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
      { fareClass: "ECONOMY", fromRow: 3, toRow: 30, seatLetters: "ABCDEF" },
    ],
  });
  assert.ok(layout.success);

  return {
    id: crypto.randomUUID(),
    registration: "VN-A321",
    model: "Airbus A321",
    createdAt: "2026-10-10T00:00:00.000Z",
    seats: layout.value,
  };
}

async function countRows(): Promise<{ aircraft: number; seats: number }> {
  const [row] = (await dataSource.query(`
    SELECT
      (SELECT count(*) FROM "aircraft")::int AS aircraft,
      (SELECT count(*) FROM "seats")::int AS seats
  `)) as { aircraft: number; seats: number }[];

  assert.ok(row);
  return row;
}

test("a seat insert failing after the aircraft row leaves neither aircraft nor seats", async () => {
  const repository = createPostgresAircraftRepository(dataSource);
  const aircraft = makeAircraft();
  // Seat 150 duplicates seat 1: the aircraft row and 149 seats would be
  // written before PK_seats fires, if create() were not atomic.
  const seats = [...aircraft.seats];
  seats.splice(149, 0, seats[0] as Aircraft["seats"][number]);

  await assert.rejects(repository.create({ ...aircraft, seats }), {
    constraint: "PK_seats",
  });

  assert.deepEqual(await countRows(), { aircraft: 0, seats: 0 });
});

test("inside a TransactionRunner, create() joins the outer transaction and rolls back with it", async () => {
  const repository = createPostgresAircraftRepository(dataSource);
  const transactionRunner = createPostgresTransactionRunner(dataSource);

  await assert.rejects(
    transactionRunner.run(async () => {
      const result = await repository.create(makeAircraft());
      assert.deepEqual(result, { outcome: "created" });
      // e.g. the audit write after it fails
      throw new Error("later step failed");
    }),
    /later step failed/,
  );

  assert.deepEqual(await countRows(), { aircraft: 0, seats: 0 });
});

test("a successful create stores the aircraft and every seat", async () => {
  const repository = createPostgresAircraftRepository(dataSource);

  await repository.create(makeAircraft());

  assert.deepEqual(await countRows(), { aircraft: 1, seats: 176 });
});
