import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../src/bootstrap/application.js";
import { createNoopMessageConsumer } from "../src/messaging/noop-message-consumer.js";
import { createNoopMessagePublisher } from "../src/messaging/noop-message-publisher.js";

const TEST_ADMIN_API_KEY = "test-admin-key-123456";

const testConfigBase = {
  port: 3000,
  adminApiKey: TEST_ADMIN_API_KEY,
  rabbitmqUrl: "amqp://guest:guest@localhost:5672",
} as const;

test("createApplication wires use cases and closes cleanly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "booking-application-"));
  const databasePath = join(directory, "booking.db");

  const runtime = await createApplication({
    config: {
      ...testConfigBase,
      databasePath,
    },
    // Keep background jobs quiet during composition smoke tests.
    flightsSummaryIntervalMs: 60 * 60 * 1000,
    messagePublisher: createNoopMessagePublisher(),
    messageConsumer: createNoopMessageConsumer(),
  });

  try {
    assert.equal(typeof runtime.createFlight, "function");
    assert.equal(typeof runtime.listFlights, "function");
    assert.equal(typeof runtime.flightRepository.findById, "function");
    assert.equal(typeof runtime.healthChecks.checkReadiness, "function");
    assert.equal(runtime.config.adminApiKey, TEST_ADMIN_API_KEY);
    assert.equal(
      "database" in runtime,
      false,
      "SQLite connection must stay private to the Composition Root",
    );

    const readiness = runtime.healthChecks.checkReadiness();
    assert.equal(readiness.status, "ok");

    await assert.doesNotReject(async () => {
      await runtime.close();
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("createApplication supports in-memory database", async () => {
  const runtime = await createApplication({
    config: {
      ...testConfigBase,
      databasePath: ":memory:",
    },
    flightsSummaryIntervalMs: 60 * 60 * 1000,
    messagePublisher: createNoopMessagePublisher(),
    messageConsumer: createNoopMessageConsumer(),
  });

  assert.equal(runtime.healthChecks.checkReadiness().status, "ok");
  await assert.doesNotReject(async () => {
    await runtime.close();
  });
});
