import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";

test("uses defaults when environment is empty", () => {
  assert.deepEqual(parseConfig({}), {
    port: 3000,
    databasePath: "data/booking.db",
  });
});

test("parses valid overrides and trims database path", () => {
  assert.deepEqual(
    parseConfig({
      PORT: "4100",
      DATABASE_PATH: " data/local.db ",
    }),
    {
      port: 4100,
      databasePath: "data/local.db",
    },
  );
});

test("rejects invalid PORT values", async (t) => {
  const cases = ["", " ", "0", "65536", "-1", "3000.5", "abc", "3000abc"];

  for (const value of cases) {
    await t.test(`rejects PORT=${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseConfig({ PORT: value }),
        (error: unknown) =>
          error instanceof Error && error.message.includes("Invalid PORT"),
      );
    });
  }
});

test("rejects blank DATABASE_PATH", () => {
  assert.throws(
    () => parseConfig({ DATABASE_PATH: "   " }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("Invalid DATABASE_PATH"),
  );
});
