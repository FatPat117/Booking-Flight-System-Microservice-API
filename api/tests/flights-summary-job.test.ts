import assert from "node:assert/strict";
import test from "node:test";

import type { FlightRepository } from "../src/flights/flight-repository.js";
import { createFlightsSummaryJob } from "../src/jobs/flights-summary-job.js";
import type { Logger, LogFields } from "../src/observability/logger.js";
import type { Flight } from "../src/types.js";

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

test("flights-summary-job logs total from repository page totalItems", async () => {
  const { logger, entries } = createMemoryLogger();
  let findPageCalls = 0;

  const flightRepository: FlightRepository = {
    findPage() {
      findPageCalls += 1;
      return {
        items: [] as Flight[],
        totalItems: 7,
      };
    },
    findById() {
      return undefined;
    },
    create() {
      return { outcome: "created" };
    },
  };

  const job = createFlightsSummaryJob({
    flightRepository,
    logger,
    intervalMs: 1_000,
  });

  assert.equal(job.name, "flights-summary-job");
  assert.equal(job.intervalMs, 1_000);

  await job.handler();

  assert.equal(findPageCalls, 1);
  assert.deepEqual(
    entries.find((entry) => entry.message === "flights_summary"),
    {
      level: "info",
      message: "flights_summary",
      fields: { total: 7 },
    },
  );
});
