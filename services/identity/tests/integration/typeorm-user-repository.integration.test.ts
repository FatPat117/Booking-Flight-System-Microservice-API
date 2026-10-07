import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { parseIdentityConfig } from "../../src/config.js";
import { createIdentityDataSource } from "../../src/data-source.js";
import { createTypeOrmUserRepository } from "../../src/users/typeorm-user-repository.js";
import { DuplicateEmailError } from "../../src/users/user-repository.js";

/**
 * Runs against the real identity_db Postgres container. Day 42: identity's
 * first test touching a real database — previously only faked via an
 * in-memory UserRepository (login.test.ts, register.test.ts).
 */

let dataSource: DataSource;

before(async () => {
  const config = parseIdentityConfig(process.env);
  dataSource = createIdentityDataSource(config.postgres);
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "users" CASCADE');
});

after(async () => {
  await dataSource.destroy();
});

test("create then findByEmail round-trips a user with default role", async () => {
  const repository = createTypeOrmUserRepository(dataSource);

  const created = await repository.create({
    email: "pilot@example.com",
    passwordHash: "hashed-password",
  });

  assert.equal(created.email, "pilot@example.com");
  assert.equal(created.role, "user");
  assert.ok(created.id);
  assert.ok(created.createdAt instanceof Date);

  const found = await repository.findByEmail("pilot@example.com");
  assert.deepEqual(found, created);
});

test("findByEmail returns undefined for an unknown email", async () => {
  const repository = createTypeOrmUserRepository(dataSource);

  const found = await repository.findByEmail("nobody@example.com");
  assert.equal(found, undefined);
});

test("create with a duplicate email throws DuplicateEmailError, mapped from Postgres's 23505", async () => {
  const repository = createTypeOrmUserRepository(dataSource);

  await repository.create({
    email: "duplicate@example.com",
    passwordHash: "hashed-password",
  });

  await assert.rejects(
    () =>
      repository.create({
        email: "duplicate@example.com",
        passwordHash: "another-hash",
      }),
    DuplicateEmailError,
  );
});
