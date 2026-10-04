import assert from "node:assert/strict";
import { test } from "node:test";

import { createPostgresHealthChecks } from "../../src/health/postgres/postgres-health-checks.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";

/**
 * Replaces the deleted SQLite health-checks unit test (Day 41) — before this,
 * PostgresHealthChecks was only exercised by the Day 40 e2e run. Read-only:
 * no tables touched, so it is safe next to a running dev stack.
 */

test("checkReadiness reports ok when the pool can serve a query", async () => {
  const dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();

  try {
    const readiness = await createPostgresHealthChecks(dataSource).checkReadiness();

    assert.deepEqual(readiness, {
      status: "ok",
      checks: { database: { status: "ok" } },
    });
  } finally {
    await dataSource.destroy();
  }
});

test("checkReadiness reports unavailable instead of throwing once the pool is gone", async () => {
  const dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.destroy();

  const readiness = await createPostgresHealthChecks(dataSource).checkReadiness();

  assert.deepEqual(readiness, {
    status: "unavailable",
    checks: { database: { status: "unavailable" } },
  });
});
