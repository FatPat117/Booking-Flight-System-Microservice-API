import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentReconciliationJob } from "../src/jobs/payment-reconciliation-job.js";
import type { Logger, LogFields } from "../src/observability/logger.js";
import type { ReconcilePaymentsResult } from "../src/payments/reconcile-payments.js";

function createMemoryLogger() {
  const entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const push = (level: string) => (message: string, fields?: LogFields) => {
    entries.push(fields === undefined ? { level, message } : { level, message, fields });
  };
  const logger: Logger = { info: push("info"), warn: push("warn"), error: push("error") };
  return { logger, entries };
}

const NOTHING = {
  settled: 0,
  refunded: 0,
  refundFailed: 0,
  retryLater: 0,
  failed: 0,
} as const;

function jobReturning(result: ReconcilePaymentsResult) {
  const { logger, entries } = createMemoryLogger();
  const job = createPaymentReconciliationJob({
    reconcilePayments: async () => result,
    logger,
    intervalMs: 30_000,
  });
  return { job, entries };
}

test("payment reconciliation job logs nothing when no payment was due", async () => {
  const { job, entries } = jobReturning({ ...NOTHING, batches: 1, exhausted: false });

  await job.handler();

  assert.equal(job.name, "payment-reconciliation-job");
  assert.equal(job.intervalMs, 30_000);
  assert.deepEqual(entries, []);
});

test("payment reconciliation job logs what each run did, and warns when a run hit its batch limit", async () => {
  const done = jobReturning({ ...NOTHING, settled: 2, refunded: 1, batches: 1, exhausted: false });
  await done.job.handler();
  assert.deepEqual(done.entries, [
    {
      level: "info",
      message: "payments_reconciled",
      fields: { ...NOTHING, settled: 2, refunded: 1, batches: 1 },
    },
  ]);

  const backlog = jobReturning({ ...NOTHING, retryLater: 100, batches: 5, exhausted: true });
  await backlog.job.handler();
  assert.deepEqual(
    backlog.entries.map(({ level, message }) => `${level}:${message}`),
    ["info:payments_reconciled", "warn:payment_reconciliation_backlog"],
  );
});
