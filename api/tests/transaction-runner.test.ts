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

test("commits operation when it succeeds", async (t) => {
  const database = createTestDatabase(t);

  const transactionRunner = createSqliteTransactionRunner(database);

  const insertItem = database.prepare(`
    INSERT INTO test_items (id, name)
    VALUES (?, ?)
  `);

  const result = await transactionRunner.run(() => {
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

test("rolls back operation when it throws", async (t) => {
  const database = createTestDatabase(t);

  const transactionRunner = createSqliteTransactionRunner(database);

  const insertItem = database.prepare(`
    INSERT INTO test_items (id, name)
    VALUES (?, ?)
  `);

  await assert.rejects(
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

test("rethrows the original operation error", async (t) => {
  const database = createTestDatabase(t);

  const transactionRunner = createSqliteTransactionRunner(database);

  const originalError = new Error("original failure");

  await assert.rejects(
    () =>
      transactionRunner.run(() => {
        throw originalError;
      }),
    (error) => error === originalError,
  );
});

test("a rejected transaction does not block later transactions from running", async (t) => {
  const database = createTestDatabase(t);

  const transactionRunner = createSqliteTransactionRunner(database);

  const insertItem = database.prepare(`
    INSERT INTO test_items (id, name)
    VALUES (?, ?)
  `);

  const first = transactionRunner.run(() => {
    throw new Error("A fails");
  });
  const second = transactionRunner.run(() => {
    insertItem.run("item-b", "B");

    return "B ok";
  });

  await assert.rejects(() => first, /A fails/);
  assert.equal(await second, "B ok");

  const third = await transactionRunner.run(() => {
    insertItem.run("item-c", "C");

    return "C ok";
  });

  assert.equal(third, "C ok");

  const row = database
    .prepare(`
      SELECT id
      FROM test_items
      WHERE id = ?
    `)
    .get("item-c");

  assert.ok(row);
});
