import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresAdminReports } from "../../src/reports/postgres/postgres-admin-reports.js";
import {
  createPostgresTransactionRunner,
  NestedTransactionError,
} from "../../src/transactions/postgres-transaction-runner.js";
import { makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { occupySeats } from "./occupy-seats.js";

/**
 * Decision 19 on Postgres: how many statements each report is, and in what
 * transaction the manifest runs. The behaviour itself is the contract's
 * (admin-reports.contract.integration.test.ts).
 */

const NOW = new Date("2026-10-10T00:00:00.000Z");
let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

/** A second DataSource that records every statement it sends. */
async function countingDataSource() {
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
  return { counting, queries };
}

const isControl = (query: string) => /^(START TRANSACTION|SET TRANSACTION|COMMIT|ROLLBACK)/.test(query.trim());

test("the manifest is two statements in one REPEATABLE READ READ ONLY transaction; load factor and audit log are one each, whatever the page size", async () => {
  const flights = createPostgresFlightRepository(dataSource);
  const created = Array.from({ length: 6 }, () => makeFlight());
  for (const flight of created) {
    assert.deepEqual(await flights.create(flight), { outcome: "created" });
    await occupySeats(dataSource, flight.id, ["1A", "1B"]);
  }
  await dataSource.query(
    `INSERT INTO "audit_logs" ("id", "action", "actor_type", "actor_id", "target_type", "target_id", "occurred_at", "metadata")
     SELECT gen_random_uuid(), 'FLIGHT_OPENED', 'system', 'test', 'flight', $1, $2::timestamptz + n * interval '1 second', '{}'
     FROM generate_series(1, 30) AS n`,
    [created[0]!.id, NOW],
  );
  const dates = created.map((flight) => flight.departureAt.slice(0, 10)).sort();

  const { counting, queries } = await countingDataSource();
  try {
    const reports = createPostgresAdminReports(counting);

    queries.length = 0;
    const manifest = await reports.findManifest(created[0]!.id, NOW);
    assert.ok(manifest);
    const control = queries.filter(isControl).map((query) => query.trim());
    assert.deepEqual(control, [
      "START TRANSACTION",
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      "SET TRANSACTION READ ONLY",
      "COMMIT",
    ]);
    assert.equal(queries.filter((query) => !isControl(query)).length, 2, queries.join("\n---\n"));

    for (const limit of [1, 5]) {
      queries.length = 0;
      const page = await reports.loadFactor({ dateFrom: dates[0]!, dateTo: dates[5]!, limit }, NOW);
      assert.equal(page.items.length, limit);
      assert.equal(queries.length, 1, queries.join("\n---\n"));

      queries.length = 0;
      const audit = await reports.auditLog({ target: { type: "flight", id: created[0]!.id }, limit: limit * 5 });
      assert.equal(audit.items.length, limit * 5);
      assert.equal(queries.length, 1, queries.join("\n---\n"));
    }
  } finally {
    await counting.destroy();
  }
});

test("the manifest refuses to run inside another transaction, whose snapshot it would not control", async () => {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  const reports = createPostgresAdminReports(dataSource);

  await assert.rejects(
    createPostgresTransactionRunner(dataSource).run(() => reports.findManifest(flight.id, NOW)),
    NestedTransactionError,
  );
});
