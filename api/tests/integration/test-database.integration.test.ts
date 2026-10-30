import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";

test("integration tests are connected to a *_test database, never booking_db", async () => {
  const dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();

  try {
    const [row] = await dataSource.query("SELECT current_database() AS name");

    assert.match(row.name, /_test$/);
  } finally {
    await dataSource.destroy();
  }
});
