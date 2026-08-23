import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/database.js";
import { createHealthChecks } from "../src/health/health-checks.js";

test("health check reports database as ok", (t) => {
  const database = openDatabase(":memory:");

  t.after(() => {
    database.close();
  });

  const healthChecks = createHealthChecks(database);

  assert.deepEqual(healthChecks.checkReadiness(), {
    status: "ok",
    checks: {
      database: {
        status: "ok",
      },
    },
  });
});

test("health check reports database as unavailable when query fails", () => {
  const database = openDatabase(":memory:");
  const healthChecks = createHealthChecks(database);

  database.close();

  assert.deepEqual(healthChecks.checkReadiness(), {
    status: "unavailable",
    checks: {
      database: {
        status: "unavailable",
      },
    },
  });
});
