import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import { openDatabase } from "../src/database.js";
import type { OutboxEntry } from "../src/outbox/outbox-repository.js";
import { createSqliteOutboxRepository } from "../src/outbox/sqlite-outbox-repository.js";
import { createSqliteTransactionRunner } from "../src/transactions/sqlite-transaction-runner.js";

function createRepo(t: TestContext) {
  const database = openDatabase(":memory:");
  const repository = createSqliteOutboxRepository(database);
  const transactionRunner = createSqliteTransactionRunner(database);

  t.after(() => {
    database.close();
  });

  return { database, repository, transactionRunner };
}

function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: crypto.randomUUID(),
    eventType: "flight-created",
    payload: { type: "flight.created", flight: { id: "f1" } },
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

test("enqueue then findUnpublished returns the entry", (t) => {
  const { repository } = createRepo(t);
  const entry = makeEntry({ id: "outbox-1" });

  repository.enqueue(entry);

  assert.deepEqual(repository.findUnpublished(10), [entry]);
});

test("markPublished removes entry from unpublished results", (t) => {
  const { repository } = createRepo(t);
  const entry = makeEntry({ id: "outbox-1" });

  repository.enqueue(entry);
  repository.markPublished(entry.id);

  assert.deepEqual(repository.findUnpublished(10), []);
});

test("findUnpublished returns rows ordered by created_at ascending", (t) => {
  const { repository } = createRepo(t);

  repository.enqueue(
    makeEntry({ id: "second", createdAt: "2026-07-20T00:00:02.000Z" }),
  );
  repository.enqueue(
    makeEntry({ id: "first", createdAt: "2026-07-20T00:00:01.000Z" }),
  );

  const unpublished = repository.findUnpublished(10);
  assert.deepEqual(
    unpublished.map((entry) => entry.id),
    ["first", "second"],
  );
});

test("findUnpublished respects limit", (t) => {
  const { repository } = createRepo(t);

  repository.enqueue(
    makeEntry({ id: "first", createdAt: "2026-07-20T00:00:01.000Z" }),
  );
  repository.enqueue(
    makeEntry({ id: "second", createdAt: "2026-07-20T00:00:02.000Z" }),
  );

  const unpublished = repository.findUnpublished(1);
  assert.equal(unpublished.length, 1);
  assert.equal(unpublished[0]?.id, "first");
});

test("enqueue rolls back with the surrounding transaction", (t) => {
  const { repository, transactionRunner } = createRepo(t);

  assert.throws(() => {
    transactionRunner.run(() => {
      repository.enqueue(makeEntry({ id: "rolled-back" }));
      throw new Error("abort");
    });
  }, /abort/);

  assert.deepEqual(repository.findUnpublished(10), []);
});
