import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";

test("uses defaults for optional configuration", () => {
  assert.deepEqual(
    parseConfig({
      JWT_SECRET: TEST_JWT_SECRET,
    }),
    {
      port: 3000,
      databasePath: "data/booking.db",
      jwtSecret: TEST_JWT_SECRET,
      rabbitmqUrl: "amqp://guest:guest@localhost:5672",
    },
  );
});

test("parses valid configuration overrides", () => {
  assert.deepEqual(
    parseConfig({
      PORT: "4100",
      DATABASE_PATH: " data/local.db ",
      JWT_SECRET: ` ${TEST_JWT_SECRET} `,
    }),
    {
      port: 4100,
      databasePath: "data/local.db",
      jwtSecret: TEST_JWT_SECRET,
      rabbitmqUrl: "amqp://guest:guest@localhost:5672",
    },
  );
});

test("rejects missing JWT_SECRET", () => {
  assert.throws(() => parseConfig({}), /JWT_SECRET/);
});

test("rejects blank JWT_SECRET", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: "   ",
      }),
    /JWT_SECRET/,
  );
});

test("rejects short JWT_SECRET", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: "too-short",
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
    }),
    {
      port: 3000,
      databasePath: "data/booking.db",
      jwtSecret: TEST_JWT_SECRET,
      rabbitmqUrl: "amqp://guest:guest@rabbitmq:5672",
    },
  );
});

test("rejects blank RABBITMQ_URL", () => {
  assert.throws(
    () =>
      parseConfig({
        JWT_SECRET: TEST_JWT_SECRET,
        RABBITMQ_URL: "   ",
      }),
    /RABBITMQ_URL/,
  );
});

test("rejects blank DATABASE_PATH", () => {
  assert.throws(
    () =>
      parseConfig({
        DATABASE_PATH: "   ",
        JWT_SECRET: TEST_JWT_SECRET,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("Invalid DATABASE_PATH"),
  );
});
