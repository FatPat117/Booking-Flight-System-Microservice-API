import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/database.js";
import { createSqliteHealthChecks } from "../src/health/sqlite-health-checks.js";

test("health check reports database as ok", async (t) => {
  const database = openDatabase(":memory:");

  t.after(() => {
    database.close();
  });

  const healthChecks = createSqliteHealthChecks(database);

  assert.deepEqual(await healthChecks.checkReadiness(), {
    status: "ok",
    checks: {
      database: {
        status: "ok",
      },
    },
  });
});

test("health check reports database as unavailable when query fails", async () => {
  const database = openDatabase(":memory:");
  const healthChecks = createSqliteHealthChecks(database);

  database.close();

  assert.deepEqual(await healthChecks.checkReadiness(), {
    status: "unavailable",
    checks: {
      database: {
        status: "unavailable",
      },
    },
  });
});
