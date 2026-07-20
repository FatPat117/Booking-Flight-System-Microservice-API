import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";

const TEST_ADMIN_API_KEY = "test-admin-key-123456";

test("uses defaults for optional configuration", () => {
  assert.deepEqual(
    parseConfig({
      ADMIN_API_KEY: TEST_ADMIN_API_KEY,
    }),
    {
      port: 3000,
      databasePath: "data/booking.db",
      adminApiKey: TEST_ADMIN_API_KEY,
    },
  );
});

test("parses valid configuration overrides", () => {
  assert.deepEqual(
    parseConfig({
      PORT: "4100",
      DATABASE_PATH: " data/local.db ",
      ADMIN_API_KEY: " local-admin-key-123456 ",
    }),
    {
      port: 4100,
      databasePath: "data/local.db",
      adminApiKey: "local-admin-key-123456",
    },
  );
});

test("rejects missing ADMIN_API_KEY", () => {
  assert.throws(() => parseConfig({}), /ADMIN_API_KEY/);
});

test("rejects blank ADMIN_API_KEY", () => {
  assert.throws(
    () =>
      parseConfig({
        ADMIN_API_KEY: "   ",
      }),
    /ADMIN_API_KEY/,
  );
});

test("rejects short ADMIN_API_KEY", () => {
  assert.throws(
    () =>
      parseConfig({
        ADMIN_API_KEY: "short",
      }),
    /ADMIN_API_KEY/,
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
            ADMIN_API_KEY: TEST_ADMIN_API_KEY,
          }),
        (error: unknown) =>
          error instanceof Error && error.message.includes("Invalid PORT"),
      );
    });
  }
});

test("rejects blank DATABASE_PATH", () => {
  assert.throws(
    () =>
      parseConfig({
        DATABASE_PATH: "   ",
        ADMIN_API_KEY: TEST_ADMIN_API_KEY,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("Invalid DATABASE_PATH"),
  );
});
