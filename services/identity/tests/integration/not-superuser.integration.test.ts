import assert from "node:assert/strict";
import { test } from "node:test";

import { DataSource } from "typeorm";

import { parseIdentityConfig } from "../../src/config.js";
import { createIdentityDataSource } from "../../src/data-source.js";

/**
 * Day 42: identity used to connect as the Postgres cluster SUPERUSER by
 * accident (POSTGRES_USER/PASSWORD collided with the image's own bootstrap
 * vars — see docker/postgres-init/00-create-identity-db.sh). This is
 * identity's first integration test — turns "identity is not a superuser"
 * from a manually-checked fact into something that fails loudly if it ever
 * regresses.
 */

test("identity connects as an ordinary role, not the cluster superuser", async () => {
  const config = parseIdentityConfig(process.env);
  const dataSource = createIdentityDataSource(config.postgres);
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

test("identity cannot CONNECT to booking_db", async () => {
  const config = parseIdentityConfig(process.env);
  const crossDataSource = new DataSource({
    type: "postgres",
    host: config.postgres.host,
    port: config.postgres.port,
    username: config.postgres.username,
    password: config.postgres.password,
    database: "booking_db",
  });

  await assert.rejects(
    () => crossDataSource.initialize(),
    /permission denied for database/,
  );
});
