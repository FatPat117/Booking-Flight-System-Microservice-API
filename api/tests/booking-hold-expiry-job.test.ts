import assert from "node:assert/strict";
import test from "node:test";

import type { ExpireHoldsResult } from "../src/bookings/expire-holds.js";
import { createBookingHoldExpiryJob } from "../src/jobs/booking-hold-expiry-job.js";
import type { Logger, LogFields } from "../src/observability/logger.js";

function createMemoryLogger() {
  const entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const push = (level: string) => (message: string, fields?: LogFields) => {
    entries.push(fields === undefined ? { level, message } : { level, message, fields });
  };
  const logger: Logger = { info: push("info"), warn: push("warn"), error: push("error") };
  return { logger, entries };
}

function jobReturning(result: ExpireHoldsResult) {
  const { logger, entries } = createMemoryLogger();
  const job = createBookingHoldExpiryJob({
    expireHolds: async () => result,
    logger,
    intervalMs: 60_000,
  });
  return { job, entries };
}

test("hold expiry job logs nothing when no hold was due", async () => {
  const { job, entries } = jobReturning({ expired: 0, batches: 1, exhausted: false });

  await job.handler();

  assert.equal(job.name, "booking-hold-expiry-job");
  assert.deepEqual(entries, []);
});

test("hold expiry job logs how many it expired, and warns when a run hit its batch limit", async () => {
  const done = jobReturning({ expired: 7, batches: 1, exhausted: false });
  await done.job.handler();
  assert.deepEqual(done.entries, [
    { level: "info", message: "booking_holds_expired", fields: { expired: 7, batches: 1 } },
  ]);

  const backlog = jobReturning({ expired: 1000, batches: 20, exhausted: true });
  await backlog.job.handler();
  assert.deepEqual(backlog.entries, [
    { level: "info", message: "booking_holds_expired", fields: { expired: 1000, batches: 20 } },
    { level: "warn", message: "booking_hold_expiry_backlog", fields: { expired: 1000, batches: 20 } },
  ]);
});
