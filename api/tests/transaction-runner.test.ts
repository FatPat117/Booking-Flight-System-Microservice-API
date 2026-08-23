import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import { openDatabase } from "../src/database.js";
import { createSqliteTransactionRunner } from "../src/transactions/sqlite-transaction-runner.js";

function createTestDatabase(t: TestContext) {
  const database = openDatabase(":memory:");

  database.exec(`
    CREATE TABLE test_items (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL
    ) STRICT;
  `);

  t.after(() => {
    database.close();
  });

  return database;
}

test("commits operation when it succeeds", (t) => {
  const database = createTestDatabase(t);

  const transactionRunner = createSqliteTransactionRunner(database);

  const insertItem = database.prepare(`
    INSERT INTO test_items (id, name)
    VALUES (?, ?)
  `);

  const result = transactionRunner.run(() => {
    insertItem.run("item-1", "A");

    return "done";
  });

  assert.equal(result, "done");

  const row = database
    .prepare(`
      SELECT id, name
      FROM test_items
      WHERE id = ?
    `)
    .get("item-1") as
    | {
        id: string;
        name: string;
      }
    | undefined;

  assert.ok(row);
  assert.equal(row.id, "item-1");
  assert.equal(row.name, "A");
});

test("rolls back operation when it throws", (t) => {
  const database = createTestDatabase(t);

  const transactionRunner = createSqliteTransactionRunner(database);

  const insertItem = database.prepare(`
    INSERT INTO test_items (id, name)
    VALUES (?, ?)
  `);

  assert.throws(
    () =>
      transactionRunner.run(() => {
        insertItem.run("item-1", "A");

        throw new Error("operation failed");
      }),
    /operation failed/,
  );

  const row = database
    .prepare(`
      SELECT id, name
      FROM test_items
      WHERE id = ?
    `)
    .get("item-1");

  assert.equal(row, undefined);
});

test("rethrows the original operation error", (t) => {
  const database = createTestDatabase(t);

  const transactionRunner = createSqliteTransactionRunner(database);

  const originalError = new Error("original failure");

  assert.throws(
    () =>
      transactionRunner.run(() => {
        throw originalError;
      }),
    (error) => error === originalError,
  );
});
