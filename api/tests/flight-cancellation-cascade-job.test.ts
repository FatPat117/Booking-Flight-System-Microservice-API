import assert from "node:assert/strict";
import test from "node:test";

import type { CascadeFlightCancellationsResult } from "../src/bookings/cascade-flight-cancellations.js";
import { createFlightCancellationCascadeJob } from "../src/jobs/flight-cancellation-cascade-job.js";
import type { Logger, LogFields } from "../src/observability/logger.js";

function createMemoryLogger() {
  const entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const push = (level: string) => (message: string, fields?: LogFields) => {
    entries.push(fields === undefined ? { level, message } : { level, message, fields });
  };
  const logger: Logger = { info: push("info"), warn: push("warn"), error: push("error") };
  return { logger, entries };
}

function jobReturning(result: CascadeFlightCancellationsResult) {
  const { logger, entries } = createMemoryLogger();
  const job = createFlightCancellationCascadeJob({
    cascadeFlightCancellations: async () => result,
    logger,
    intervalMs: 30_000,
  });
  return { job, entries };
}

test("flight cancellation cascade job logs nothing when no cancelled flight has a live booking", async () => {
  const { job, entries } = jobReturning({ cancelled: 0, refundsStarted: 0, flightsCompleted: 0, exhausted: false });

  await job.handler();

  assert.equal(job.name, "flight-cancellation-cascade-job");
  assert.equal(job.intervalMs, 30_000);
  assert.deepEqual(entries, []);
});

test("flight cancellation cascade job logs what it cancelled, and warns when a run hit its limit", async () => {
  const done = jobReturning({ cancelled: 3, refundsStarted: 2, flightsCompleted: 1, exhausted: false });
  await done.job.handler();
  assert.deepEqual(done.entries, [
    { level: "info", message: "flight_cancellation_cascaded", fields: { cancelled: 3, refundsStarted: 2, flightsCompleted: 1 } },
  ]);

  const backlog = jobReturning({ cancelled: 500, refundsStarted: 410, flightsCompleted: 0, exhausted: true });
  await backlog.job.handler();
  assert.deepEqual(backlog.entries, [
    { level: "info", message: "flight_cancellation_cascaded", fields: { cancelled: 500, refundsStarted: 410, flightsCompleted: 0 } },
    { level: "warn", message: "flight_cancellation_cascade_backlog", fields: { cancelled: 500 } },
  ]);
});

test("flight cancellation cascade job logs a run that only marked flights complete", async () => {
  const { job, entries } = jobReturning({ cancelled: 0, refundsStarted: 0, flightsCompleted: 2, exhausted: false });

  await job.handler();

  assert.deepEqual(entries, [
    {
      level: "info",
      message: "flight_cancellation_cascaded",
      fields: { cancelled: 0, refundsStarted: 0, flightsCompleted: 2 },
    },
  ]);
});
