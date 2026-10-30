import assert from "node:assert/strict";
import test from "node:test";

import type { CleanupIdempotencyKeysResult } from "../src/idempotency/cleanup-idempotency-keys.js";
import { createIdempotencyKeyCleanupJob } from "../src/jobs/idempotency-key-cleanup-job.js";
import type { Logger, LogFields } from "../src/observability/logger.js";

function jobReturning(result: CleanupIdempotencyKeysResult) {
  const entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const push = (level: string) => (message: string, fields?: LogFields) => {
    entries.push(fields === undefined ? { level, message } : { level, message, fields });
  };
  const logger: Logger = { info: push("info"), warn: push("warn"), error: push("error") };
  const job = createIdempotencyKeyCleanupJob({
    cleanupIdempotencyKeys: async () => result,
    logger,
    intervalMs: 3_600_000,
  });
  return { job, entries };
}

test("idempotency key cleanup job logs nothing when no key had expired", async () => {
  const { job, entries } = jobReturning({ deleted: 0, batches: 1, exhausted: false });

  await job.handler();

  assert.equal(job.name, "idempotency-key-cleanup-job");
  assert.deepEqual(entries, []);
});

test("idempotency key cleanup job logs how many it deleted, and warns when a run hit its batch limit", async () => {
  const backlog = jobReturning({ deleted: 10_000, batches: 20, exhausted: true });

  await backlog.job.handler();

  assert.deepEqual(backlog.entries, [
    { level: "info", message: "idempotency_keys_deleted", fields: { deleted: 10_000, batches: 20 } },
    {
      level: "warn",
      message: "idempotency_key_cleanup_backlog",
      fields: { deleted: 10_000, batches: 20 },
    },
  ]);
});
