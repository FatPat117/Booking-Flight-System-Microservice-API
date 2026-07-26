import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../src/bootstrap/application.js";

const TEST_ADMIN_API_KEY = "test-admin-key-123456";

test("createApplication wires use cases and closes cleanly", () => {
  const directory = mkdtempSync(join(tmpdir(), "booking-application-"));
  const databasePath = join(directory, "booking.db");

  const runtime = createApplication({
    config: {
      port: 3000,
      databasePath,
      adminApiKey: TEST_ADMIN_API_KEY,
    },
    // Keep background jobs quiet during composition smoke tests.
    flightsSummaryIntervalMs: 60 * 60 * 1000,
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

    assert.doesNotThrow(() => {
      runtime.close();
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("createApplication supports in-memory database", () => {
  const runtime = createApplication({
    config: {
      port: 3000,
      databasePath: ":memory:",
      adminApiKey: TEST_ADMIN_API_KEY,
    },
    flightsSummaryIntervalMs: 60 * 60 * 1000,
  });

  assert.equal(runtime.healthChecks.checkReadiness().status, "ok");
  assert.doesNotThrow(() => {
    runtime.close();
  });
});
