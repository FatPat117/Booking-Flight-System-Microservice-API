import assert from "node:assert/strict";
import test from "node:test";

import {
  addMoney,
  type Money,
  parseVndFromDatabase,
  sumMoney,
  vnd,
} from "../src/money/money.js";

test("a VND amount is whole đồng and is never multiplied by 100", () => {
  assert.deepEqual(vnd(1_500_000), { amount: 1_500_000, currency: "VND" });
  assert.deepEqual(vnd(0), { amount: 0, currency: "VND" });
});

test("negative, fractional, non-finite and unsafe amounts are rejected", () => {
  for (const amount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    assert.throws(() => vnd(amount), RangeError, String(amount));
  }
});

test("adding and summing money adds the integer amounts exactly", () => {
  assert.deepEqual(addMoney(vnd(1_500_000), vnd(4_200_000)), vnd(5_700_000));
  assert.deepEqual(
    sumMoney([vnd(1_500_000), vnd(1_500_000), vnd(4_200_000)], "VND"),
    vnd(7_200_000),
  );
});

test("the sum of no amounts is zero in the given currency", () => {
  assert.deepEqual(sumMoney([], "VND"), vnd(0));
});

test("adding two different currencies throws instead of mixing them", () => {
  // Only VND exists today; the cast stands in for a second currency.
  const usd = { amount: 100, currency: "USD" } as unknown as Money;

  assert.throws(() => addMoney(vnd(1), usd), TypeError);
});

test("a sum that leaves the safe integer range throws instead of rounding", () => {
  assert.throws(
    () => addMoney(vnd(Number.MAX_SAFE_INTEGER), vnd(1)),
    RangeError,
  );
});

test("a bigint string from the database becomes a number of đồng", () => {
  assert.deepEqual(parseVndFromDatabase("1500000"), vnd(1_500_000));
  assert.deepEqual(parseVndFromDatabase("0"), vnd(0));
  assert.deepEqual(
    parseVndFromDatabase(String(Number.MAX_SAFE_INTEGER)),
    vnd(Number.MAX_SAFE_INTEGER),
  );
  assert.deepEqual(parseVndFromDatabase(4_200_000), vnd(4_200_000));
});

test("a database value that is not an exact whole number of đồng throws", () => {
  // 2^53 + 1: Number() would silently round it to 2^53.
  for (const value of ["9007199254740993", "1.5", "abc", "-1", "", " 1", "1e6", -1]) {
    assert.throws(
      () => parseVndFromDatabase(value),
      RangeError,
      JSON.stringify(value),
    );
  }
});
