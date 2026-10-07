import assert from "node:assert/strict";
import { test } from "node:test";

import { DataSource } from "typeorm";

import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";

/**
 * Day 42: identity used to connect as the Postgres cluster SUPERUSER by
 * accident, which made the REVOKE CONNECT added for booking_db in Day 40
 * meaningless in that direction (superuser bypasses every REVOKE). booking
 * itself was never superuser, but this closes the gap by testing both the
 * same fact for booking and the direction that used to be unprotected.
 */

test("booking connects as an ordinary role, not the cluster superuser", async () => {
  const dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();

  try {
    const [row] = await dataSource.query(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
    );

    assert.equal(row.rolsuper, false);
  } finally {
    await dataSource.destroy();
  }
});

test("booking cannot CONNECT to identity_db", async () => {
  const config = parsePostgresConfig(process.env);
  const crossDataSource = new DataSource({
    type: "postgres",
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: "identity_db",
  });

  await assert.rejects(
    () => crossDataSource.initialize(),
    /permission denied for database/,
  );
});
