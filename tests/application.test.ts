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

  const application = createApplication({
    config: {
      port: 3000,
      databasePath,
      adminApiKey: TEST_ADMIN_API_KEY,
    },
  });

  try {
    assert.equal(typeof application.createFlight, "function");
    assert.equal(typeof application.listFlights, "function");
    assert.equal(typeof application.flightRepository.findById, "function");
    assert.equal(typeof application.healthChecks.checkReadiness, "function");
    assert.equal(application.config.adminApiKey, TEST_ADMIN_API_KEY);

    const readiness = application.healthChecks.checkReadiness();
    assert.equal(readiness.status, "ok");

    assert.doesNotThrow(() => {
      application.close();
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("createApplication supports in-memory database", () => {
  const application = createApplication({
    config: {
      port: 3000,
      databasePath: ":memory:",
      adminApiKey: TEST_ADMIN_API_KEY,
    },
  });

  assert.equal(application.healthChecks.checkReadiness().status, "ok");
  assert.doesNotThrow(() => {
    application.close();
  });
});
