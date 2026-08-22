import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../src/database.js";
import type { Migration } from "../src/migrations/migration.js";
import { runMigrations } from "../src/migrations/migration-runner.js";
import { migrations } from "../src/migrations/migrations.js";

function createMemoryDatabase(t: TestContext) {
  const database = new DatabaseSync(":memory:");

  t.after(() => {
    database.close();
  });

  return database;
}

test("runs pending migrations in order", (t) => {
  const database = createMemoryDatabase(t);

  const calls: string[] = [];

  const testMigrations: Migration[] = [
    {
      id: "001_first",
      up(db) {
        calls.push("001_first");

        db.exec(`
          CREATE TABLE first_table (
            id TEXT PRIMARY KEY NOT NULL
          ) STRICT;
        `);
      },
    },
    {
      id: "002_second",
      up(db) {
        calls.push("002_second");

        db.exec(`
          CREATE TABLE second_table (
            id TEXT PRIMARY KEY NOT NULL
          ) STRICT;
        `);
      },
    },
  ];

  runMigrations(database, testMigrations);

  assert.deepEqual(calls, ["001_first", "002_second"]);

  const rows = database
    .prepare(
      `
      SELECT id
      FROM schema_migrations
      ORDER BY id ASC
    `,
    )
    .all() as Array<{ id: string }>;

  assert.deepEqual(
    rows.map((row) => row.id),
    ["001_first", "002_second"],
  );
});

test("does not rerun already applied migrations", (t) => {
  const database = createMemoryDatabase(t);

  let runCount = 0;

  const testMigrations: Migration[] = [
    {
      id: "001_once",
      up(db) {
        runCount += 1;

        db.exec(`
          CREATE TABLE once_table (
            id TEXT PRIMARY KEY NOT NULL
          ) STRICT;
        `);
      },
    },
  ];

  runMigrations(database, testMigrations);
  runMigrations(database, testMigrations);

  assert.equal(runCount, 1);

  const rows = database
    .prepare(
      `
      SELECT id
      FROM schema_migrations
      WHERE id = ?
    `,
    )
    .all("001_once");

  assert.equal(rows.length, 1);
});

test("rolls back failed migration and does not mark it applied", (t) => {
  const database = createMemoryDatabase(t);

  const testMigrations: Migration[] = [
    {
      id: "001_fails",
      up(db) {
        db.exec(`
          CREATE TABLE partial_table (
            id TEXT PRIMARY KEY NOT NULL
          ) STRICT;
        `);

        throw new Error("migration failed");
      },
    },
  ];

  assert.throws(
    () => runMigrations(database, testMigrations),
    /migration failed/,
  );

  const migrationRow = database
    .prepare(
      `
      SELECT id
      FROM schema_migrations
      WHERE id = ?
    `,
    )
    .get("001_fails");

  assert.equal(migrationRow, undefined);

  const tableRow = database
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'partial_table'
    `,
    )
    .get();

  assert.equal(tableRow, undefined);
});

test("openDatabase applies application migrations on empty database", (t) => {
  const database = openDatabase(":memory:");

  t.after(() => {
    database.close();
  });

  const tables = database
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name ASC
    `,
    )
    .all() as Array<{ name: string }>;

  const tableNames = tables.map((table) => table.name);

  assert.ok(tableNames.includes("flights"));
  assert.ok(tableNames.includes("audit_logs"));
  assert.ok(tableNames.includes("outbox"));
  assert.ok(tableNames.includes("schema_migrations"));

  const applied = database
    .prepare(
      `
      SELECT id
      FROM schema_migrations
      ORDER BY id ASC
    `,
    )
    .all() as Array<{ id: string }>;

  assert.deepEqual(
    applied.map((row) => row.id),
    ["001_create_flights", "002_create_audit_logs", "003_create_outbox"],
  );
});

test("migrations adopt an existing pre-migration schema", (t) => {
  const database = createMemoryDatabase(t);

  database.exec(`
    CREATE TABLE flights (
      id TEXT PRIMARY KEY NOT NULL,
      flight_number TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (length(origin) = 3),
      destination TEXT NOT NULL CHECK (length(destination) = 3),
      departure_at TEXT NOT NULL,
      arrival_at TEXT NOT NULL,
      price_in_cents INTEGER NOT NULL CHECK (price_in_cents > 0),
      currency TEXT NOT NULL CHECK (currency IN ('VND', 'USD')),
      available_seats INTEGER NOT NULL CHECK (available_seats >= 0),
      CHECK (origin <> destination),
      CHECK (arrival_at > departure_at),
      UNIQUE (flight_number, departure_at)
    ) STRICT;

    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY NOT NULL,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      request_id TEXT,
      occurred_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      CHECK (length(action) > 0),
      CHECK (length(actor_type) > 0),
      CHECK (length(actor_id) > 0),
      CHECK (length(target_type) > 0),
      CHECK (length(target_id) > 0),
      CHECK (length(occurred_at) > 0),
      CHECK (length(metadata_json) > 0)
    ) STRICT;
  `);

  runMigrations(database, migrations);

  const applied = database
    .prepare(
      `
      SELECT id
      FROM schema_migrations
      ORDER BY id ASC
    `,
    )
    .all() as Array<{ id: string }>;

  assert.deepEqual(
    applied.map((row) => row.id),
    ["001_create_flights", "002_create_audit_logs", "003_create_outbox"],
  );

  const flightsTable = database
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'flights'
    `,
    )
    .get();

  assert.ok(flightsTable);
});
