import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import {
  createPostgresOutboxRepository,
  OutboxEnqueueOutsideTransactionError,
} from "../../src/outbox/postgres/postgres-outbox-repository.js";
import type { OutboxEntry } from "../../src/outbox/outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";

let dataSource: DataSource;

function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: crypto.randomUUID(),
    eventType: "flight-created",
    payload: { type: "flight.created", flight: { id: "f1" } },
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "outbox"');
});

after(async () => {
  await dataSource.destroy();
});

test("enqueue then findUnpublished round-trips payload as an object, not a JSON string", async () => {
  const repository = createPostgresOutboxRepository(dataSource);
  const runner = createPostgresTransactionRunner(dataSource);
  const entry = makeEntry();

  await runner.run(() => repository.enqueue(entry));

  const unpublished = await repository.findUnpublished(10);
  assert.deepEqual(unpublished, [entry]);
  assert.equal(typeof unpublished[0]?.payload, "object");
});

test("markPublished removes the entry from findUnpublished", async () => {
  const repository = createPostgresOutboxRepository(dataSource);
  const runner = createPostgresTransactionRunner(dataSource);
  const entry = makeEntry();

  await runner.run(() => repository.enqueue(entry));
  await repository.markPublished(entry.id);

  assert.deepEqual(await repository.findUnpublished(10), []);
});

test("findUnpublished orders by created_at ascending and respects limit", async () => {
  const repository = createPostgresOutboxRepository(dataSource);
  const runner = createPostgresTransactionRunner(dataSource);

  const second = makeEntry({
    id: crypto.randomUUID(),
    createdAt: "2026-07-20T00:00:02.000Z",
  });
  const first = makeEntry({
    id: crypto.randomUUID(),
    createdAt: "2026-07-20T00:00:01.000Z",
  });

  await runner.run(() => repository.enqueue(second));
  await runner.run(() => repository.enqueue(first));

  const unpublished = await repository.findUnpublished(1);
  assert.equal(unpublished.length, 1);
  assert.equal(unpublished[0]?.id, first.id);
});

test("enqueue outside a transaction throws OutboxEnqueueOutsideTransactionError", async () => {
  const repository = createPostgresOutboxRepository(dataSource);

  await assert.rejects(
    () => repository.enqueue(makeEntry()),
    OutboxEnqueueOutsideTransactionError,
  );

  assert.deepEqual(await repository.findUnpublished(10), []);
});

test("findUnpublished's query uses the idx_outbox_unpublished partial index", async () => {
  const rows = (await dataSource.query(
    `EXPLAIN SELECT id, event_type, payload, created_at
     FROM outbox
     WHERE published_at IS NULL
     ORDER BY created_at ASC
     LIMIT 20`,
  )) as Array<Record<string, string>>;

  const planText = rows.map((row) => row["QUERY PLAN"]).join("\n");
  assert.match(planText, /idx_outbox_unpublished/);
});
