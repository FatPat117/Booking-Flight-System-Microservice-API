import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import {
  type IdempotencyScope,
  PAY_BOOKING_OPERATION,
} from "../../src/idempotency/idempotency-repository.js";
import { createPostgresIdempotencyRepository } from "../../src/idempotency/postgres/postgres-idempotency-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { runIdempotencyRepositoryContract } from "../contracts/idempotency-repository.contract.js";

/**
 * The contract the in-memory fake runs in the unit tier
 * (tests/idempotency-repository.contract.test.ts), against real Postgres,
 * plus the one behavior a fake cannot have: a claim of a key whose first
 * claim is not committed yet waits for it.
 */

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "idempotency_keys"');
});

after(async () => {
  await dataSource.destroy();
});

runIdempotencyRepositoryContract("postgres", async () =>
  createPostgresIdempotencyRepository(dataSource),
);

const NOW = new Date("2026-11-01T00:00:00.000Z");

function scopeOf(accountId: string): IdempotencyScope {
  return { accountId, operation: PAY_BOOKING_OPERATION };
}

test("a concurrent claim waits for the first claim's transaction: in-progress if it commits", async () => {
  const repository = createPostgresIdempotencyRepository(dataSource);
  const runner = createPostgresTransactionRunner(dataSource);
  const scope = scopeOf(crypto.randomUUID());
  let releaseFirst!: () => void;
  const firstMayCommit = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = runner.run(async () => {
    const result = await repository.claim(scope, "key-1", "fp-a", NOW);
    await firstMayCommit;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  let secondSettled = false;
  const second = repository
    .claim(scope, "key-1", "fp-b", NOW)
    .finally(() => {
      secondSettled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondSettled, false, "the second claim must wait for the first transaction");

  releaseFirst();

  assert.deepEqual(await first, { outcome: "claimed" });
  assert.deepEqual(await second, { outcome: "in-progress", fingerprint: "fp-a" });
});

test("a concurrent claim waits for the first claim's transaction: claimed if it rolls back", async () => {
  const repository = createPostgresIdempotencyRepository(dataSource);
  const runner = createPostgresTransactionRunner(dataSource);
  const scope = scopeOf(crypto.randomUUID());
  let releaseFirst!: () => void;
  const firstMayEnd = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = runner.run(async () => {
    await repository.claim(scope, "key-1", "fp-a", NOW);
    await firstMayEnd;
    throw new Error("phase 1 failed");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = repository.claim(scope, "key-1", "fp-b", NOW);
  releaseFirst();

  await assert.rejects(first, /phase 1 failed/);
  assert.deepEqual(await second, { outcome: "claimed" });
});
