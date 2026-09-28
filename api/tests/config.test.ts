import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";

const validPostgresEnv = {
  BOOKING_POSTGRES_USER: "booking",
  BOOKING_POSTGRES_PASSWORD: "booking_dev_password",
};

test("uses defaults for optional configuration", () => {
  assert.deepEqual(
    parseConfig({
      JWT_SECRET: TEST_JWT_SECRET,
      ...validPostgresEnv,
    }),
    {
      port: 3000,
      jwtSecret: TEST_JWT_SECRET,
      rabbitmqUrl: "amqp://guest:guest@localhost:5672",
      postgres: {
        host: "localhost",
        port: 5432,
        username: "booking",
        password: "booking_dev_password",
        database: "booking_db",
      },
    },
  );
});

test("parses valid configuration overrides", () => {
  assert.deepEqual(
    parseConfig({
      PORT: "4100",
      JWT_SECRET: ` ${TEST_JWT_SECRET} `,
      POSTGRES_HOST: " db.internal ",
      POSTGRES_PORT: "6543",
      BOOKING_POSTGRES_USER: " booking ",
      BOOKING_POSTGRES_PASSWORD: " s3cret ",
    }),
    {
      port: 4100,
      jwtSecret: TEST_JWT_SECRET,
      rabbitmqUrl: "amqp://guest:guest@localhost:5672",
      postgres: {
        host: "db.internal",
        port: 6543,
        username: "booking",
        password: "s3cret",
        database: "booking_db",
      },
    },
  );
});

test("rejects missing JWT_SECRET", () => {
  assert.throws(
    () => parseConfig({ ...validPostgresEnv }),
    /JWT_SECRET/,
  );
});

test("rejects blank JWT_SECRET", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: "   ",
        ...validPostgresEnv,
      }),
    /JWT_SECRET/,
  );
});

test("rejects short JWT_SECRET", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: "too-short",
        ...validPostgresEnv,
      }),
    /JWT_SECRET/,
  );
});

test("rejects invalid PORT values", async (t) => {
  const cases = ["", " ", "0", "65536", "-1", "3000.5", "abc", "3000abc"];

  for (const value of cases) {
    await t.test(`rejects PORT=${JSON.stringify(value)}`, () => {
      assert.throws(
        () =>
          parseConfig({
            PORT: value,
            JWT_SECRET: TEST_JWT_SECRET,
            ...validPostgresEnv,
          }),
        (error: unknown) =>
          error instanceof Error && error.message.includes("Invalid PORT"),
      );
    });
  }
});

test("parses RABBITMQ_URL override", () => {
  assert.deepEqual(
    parseConfig({
      JWT_SECRET: TEST_JWT_SECRET,
      RABBITMQ_URL: " amqp://guest:guest@rabbitmq:5672 ",
      ...validPostgresEnv,
    }),
    {
      port: 3000,
      jwtSecret: TEST_JWT_SECRET,
      rabbitmqUrl: "amqp://guest:guest@rabbitmq:5672",
      postgres: {
        host: "localhost",
        port: 5432,
        username: "booking",
        password: "booking_dev_password",
        database: "booking_db",
      },
    },
  );
});

test("rejects blank RABBITMQ_URL", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: TEST_JWT_SECRET,
        RABBITMQ_URL: "   ",
        ...validPostgresEnv,
      }),
    /RABBITMQ_URL/,
  );
});

test("rejects missing BOOKING_POSTGRES_USER", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: TEST_JWT_SECRET,
        BOOKING_POSTGRES_PASSWORD: "booking_dev_password",
      }),
    /BOOKING_POSTGRES_USER/,
  );
});

test("rejects blank BOOKING_POSTGRES_USER", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: TEST_JWT_SECRET,
        BOOKING_POSTGRES_USER: "   ",
        BOOKING_POSTGRES_PASSWORD: "booking_dev_password",
      }),
    /BOOKING_POSTGRES_USER/,
  );
});

test("rejects missing BOOKING_POSTGRES_PASSWORD", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: TEST_JWT_SECRET,
        BOOKING_POSTGRES_USER: "booking",
      }),
    /BOOKING_POSTGRES_PASSWORD/,
  );
});

test("rejects invalid POSTGRES_PORT values", async (t) => {
  // "" / " " are not included: like identity's own parsePostgresPort, a
  // blank POSTGRES_PORT means "use the default", not an error.
  const cases = ["0", "65536", "-1", "3000.5", "abc"];

  for (const value of cases) {
    await t.test(`rejects POSTGRES_PORT=${JSON.stringify(value)}`, () => {
      assert.throws(
        () =>
          parseConfig({
            JWT_SECRET: TEST_JWT_SECRET,
            POSTGRES_PORT: value,
            ...validPostgresEnv,
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("Invalid POSTGRES_PORT"),
      );
    });
  }
});
