import assert from "node:assert/strict";
import test from "node:test";

import {
  createCleanupIdempotencyKeys,
  IDEMPOTENCY_KEY_RETENTION_MS,
} from "../src/idempotency/cleanup-idempotency-keys.js";
import {
  type IdempotencyScope,
  PAY_BOOKING_OPERATION,
} from "../src/idempotency/idempotency-repository.js";
import {
  createInMemoryIdempotencyRepository,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const SCOPE: IdempotencyScope = { accountId: crypto.randomUUID(), operation: PAY_BOOKING_OPERATION };
const RESPONSE = { status: 201, body: {} };

async function setup(options: { batchSize: number; maxBatches: number }) {
  const idempotencyRepository = createInMemoryIdempotencyRepository();
  const cleanup = createCleanupIdempotencyKeys({
    idempotencyRepository,
    transactionRunner: createInMemoryTransactionRunner(),
    getCurrentTime: () => NOW,
    ...options,
  });
  async function completedKey(key: string, msBeforeNow: number) {
    const at = new Date(NOW.getTime() - msBeforeNow);
    await idempotencyRepository.claim(SCOPE, key, "fp", at);
    await idempotencyRepository.complete(SCOPE, key, RESPONSE, at);
  }
  const outcomeOf = async (key: string) =>
    (await idempotencyRepository.claim(SCOPE, key, "fp", NOW)).outcome;
  return { idempotencyRepository, cleanup, completedKey, outcomeOf };
}

test("cleanup deletes completed keys older than 24 h; one created exactly 24 h ago, a younger one, and one still in progress stay", async () => {
  const { idempotencyRepository, cleanup, completedKey, outcomeOf } = await setup({
    batchSize: 10,
    maxBatches: 5,
  });
  await completedKey("expired", IDEMPOTENCY_KEY_RETENTION_MS + 1);
  await completedKey("boundary", IDEMPOTENCY_KEY_RETENTION_MS);
  await completedKey("young", 60_000);
  await idempotencyRepository.claim(
    SCOPE,
    "in-progress",
    "fp",
    new Date(NOW.getTime() - 2 * IDEMPOTENCY_KEY_RETENTION_MS),
  );

  assert.deepEqual(await cleanup(), { deleted: 1, batches: 1, exhausted: false });

  assert.equal(await outcomeOf("expired"), "claimed");
  assert.equal(await outcomeOf("boundary"), "completed");
  assert.equal(await outcomeOf("young"), "completed");
  assert.equal(await outcomeOf("in-progress"), "in-progress");
});

test("cleanup works in batches and stops at its batch limit, reporting the backlog", async () => {
  const { cleanup, completedKey } = await setup({ batchSize: 2, maxBatches: 2 });
  for (let index = 0; index < 5; index += 1) {
    await completedKey(`key-${index}`, IDEMPOTENCY_KEY_RETENTION_MS + 1_000 + index);
  }

  assert.deepEqual(await cleanup(), { deleted: 4, batches: 2, exhausted: true });
  assert.deepEqual(await cleanup(), { deleted: 1, batches: 1, exhausted: false });
});
