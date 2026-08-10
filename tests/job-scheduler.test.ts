import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryJobScheduler } from "../src/jobs/in-memory-job-scheduler.js";
import type { Logger, LogFields } from "../src/observability/logger.js";

function createMemoryLogger() {
  const entries: Array<{
    level: string;
    message: string;
    fields?: LogFields;
  }> = [];

  const logger: Logger = {
    info(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "info", message }
          : { level: "info", message, fields },
      );
    },
    warn(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "warn", message }
          : { level: "warn", message, fields },
      );
    },
    error(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "error", message }
          : { level: "error", message, fields },
      );
    },
  };

  return { logger, entries };
}

/** Flush microtasks so async setTimeout handlers settle under MockTimers. */
async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("scheduler runs registered job after interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { logger, entries } = createMemoryLogger();
  const scheduler = createInMemoryJobScheduler(logger);
  let runs = 0;

  scheduler.register({
    name: "probe-job",
    intervalMs: 100,
    handler: async () => {
      runs += 1;
    },
  });

  scheduler.start();
  assert.equal(runs, 0);

  t.mock.timers.tick(100);
  await flushAsyncWork();
  assert.equal(runs, 1);
  assert.ok(
    entries.some(
      (entry) =>
        entry.message === "job_completed" && entry.fields?.job === "probe-job",
    ),
  );

  scheduler.stop();
});

test("scheduler does not overlap while a long handler is running", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { logger } = createMemoryLogger();
  const scheduler = createInMemoryJobScheduler(logger);
  let concurrent = 0;
  let maxConcurrent = 0;
  let runs = 0;
  let release!: () => void;

  scheduler.register({
    name: "slow-job",
    intervalMs: 50,
    handler: async () => {
      runs += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      concurrent -= 1;
    },
  });

  scheduler.start();
  t.mock.timers.tick(50);
  await flushAsyncWork();
  assert.equal(runs, 1);
  assert.equal(concurrent, 1);

  // While the first run is still awaiting, advancing time must not start another.
  t.mock.timers.tick(200);
  await flushAsyncWork();
  assert.equal(runs, 1);
  assert.equal(maxConcurrent, 1);

  release();
  await flushAsyncWork();
  t.mock.timers.tick(50);
  await flushAsyncWork();
  assert.equal(runs, 2);
  assert.equal(maxConcurrent, 1);

  scheduler.stop();
});

test("scheduler logs job failure and keeps scheduling the same job", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { logger, entries } = createMemoryLogger();
  const scheduler = createInMemoryJobScheduler(logger);
  let runs = 0;

  scheduler.register({
    name: "failing-job",
    intervalMs: 40,
    handler: async () => {
      runs += 1;
      if (runs === 1) {
        throw new Error("boom");
      }
    },
  });

  scheduler.start();
  t.mock.timers.tick(40);
  await flushAsyncWork();
  assert.equal(runs, 1);
  assert.ok(
    entries.some(
      (entry) =>
        entry.level === "error" &&
        entry.message === "job_failed" &&
        entry.fields?.job === "failing-job",
    ),
  );

  t.mock.timers.tick(40);
  await flushAsyncWork();
  assert.equal(runs, 2);

  scheduler.stop();
});

test("job A failure does not stop job B from running on its next tick", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { logger, entries } = createMemoryLogger();
  const scheduler = createInMemoryJobScheduler(logger);
  let jobARuns = 0;
  let jobBRuns = 0;

  scheduler.register({
    name: "job-a",
    intervalMs: 50,
    handler: async () => {
      jobARuns += 1;
      throw new Error("job A exploded");
    },
  });

  scheduler.register({
    name: "job-b",
    intervalMs: 50,
    handler: async () => {
      jobBRuns += 1;
    },
  });

  scheduler.start();

  t.mock.timers.tick(50);
  await flushAsyncWork();
  assert.equal(jobARuns, 1);
  assert.equal(jobBRuns, 1);
  assert.ok(
    entries.some(
      (entry) =>
        entry.level === "error" &&
        entry.message === "job_failed" &&
        entry.fields?.job === "job-a",
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.message === "job_completed" && entry.fields?.job === "job-b",
    ),
  );

  t.mock.timers.tick(50);
  await flushAsyncWork();
  assert.equal(jobARuns, 2);
  assert.equal(jobBRuns, 2);

  scheduler.stop();
});

test("stop prevents further runs and is idempotent when called twice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { logger } = createMemoryLogger();
  const scheduler = createInMemoryJobScheduler(logger);
  let runs = 0;

  scheduler.register({
    name: "stoppable-job",
    intervalMs: 25,
    handler: async () => {
      runs += 1;
    },
  });

  scheduler.start();
  t.mock.timers.tick(25);
  await flushAsyncWork();
  assert.equal(runs, 1);

  assert.doesNotThrow(() => {
    scheduler.stop();
  });
  assert.doesNotThrow(() => {
    scheduler.stop();
  });

  t.mock.timers.tick(200);
  await flushAsyncWork();
  assert.equal(runs, 1);
});
