import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../../src/bootstrap/application.js";
import { createNoopMessagePublisher } from "../../src/messaging/noop-message-publisher.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";

/**
 * Day 40 — moved from tests/application.test.ts (unit tier). Before
 * cutover, createApplication() opened a throwaway node:sqlite file/:memory:
 * database per test, so this ran with no external dependency. After
 * cutover, createApplication() always builds a real Postgres DataSource —
 * there is no in-process equivalent left, so this is now, correctly, an
 * integration test (same tier as the *.integration.test.ts files beside
 * it), not a unit test pretending Postgres isn't required.
 */

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";

const testConfigBase = {
  port: 3000,
  jwtSecret: TEST_JWT_SECRET,
  rabbitmqUrl: "amqp://guest:guest@localhost:5672",
  postgres: parsePostgresConfig(process.env),
} as const;

test("createApplication wires use cases, migrates the real database, and closes cleanly", async () => {
  const runtime = await createApplication({
    config: testConfigBase,
    // Keep background jobs quiet during composition smoke tests.
    flightsSummaryIntervalMs: 60 * 60 * 1000,
    messagePublisher: createNoopMessagePublisher(),
  });

  try {
    assert.equal(typeof runtime.createFlight, "function");
    assert.equal(typeof runtime.createBooking, "function");
    assert.equal(typeof runtime.cancelBooking, "function");
    assert.equal(typeof runtime.listFlights, "function");
    assert.equal(typeof runtime.flightRepository.findById, "function");
    assert.equal(typeof runtime.healthChecks.checkReadiness, "function");
    assert.equal(runtime.config.jwtSecret, TEST_JWT_SECRET);
    assert.equal(
      "dataSource" in runtime,
      false,
      "the Postgres DataSource must stay private to the Composition Root",
    );

    const readiness = await runtime.healthChecks.checkReadiness();
    assert.equal(readiness.status, "ok");
  } finally {
    await assert.doesNotReject(async () => {
      await runtime.close();
    });
  }
});
