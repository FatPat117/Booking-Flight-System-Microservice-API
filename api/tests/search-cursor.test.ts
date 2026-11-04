import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchCursorScope,
} from "../src/flights/search-cursor.js";

const SCOPE: SearchCursorScope = {
  origin: "SGN",
  destination: "HAN",
  departureDateFrom: "2026-12-01",
  departureDateTo: "2026-12-03",
  passengers: 2,
  sort: "departure",
};
const KEY = {
  departureAt: "2026-12-01T01:00:00.000Z",
  id: "0b6c1f0e-8d2a-4c1e-9a6f-3f1d2c4b5a69",
  lowestFare: 1_500_000,
};

test("a cursor decodes back to the key it was made from, for both sort orders", () => {
  assert.deepEqual(decodeSearchCursor(encodeSearchCursor(KEY, SCOPE), SCOPE), {
    success: true,
    key: { ...KEY, lowestFare: 0 },
  });
  const byPrice = { ...SCOPE, sort: "price" as const };
  assert.deepEqual(decodeSearchCursor(encodeSearchCursor(KEY, byPrice), byPrice), { success: true, key: KEY });
});

test("a cursor is refused by any other search: route, dates, passengers or sort changed", () => {
  const cursor = encodeSearchCursor(KEY, SCOPE);
  const others: SearchCursorScope[] = [
    { ...SCOPE, origin: "DAD" },
    { ...SCOPE, destination: "SGN", origin: "HAN" },
    { ...SCOPE, departureDateFrom: "2026-12-02" },
    { ...SCOPE, departureDateTo: "2026-12-04" },
    { ...SCOPE, passengers: 3 },
    { ...SCOPE, sort: "price" },
  ];
  for (const other of others) {
    assert.deepEqual(decodeSearchCursor(cursor, other), { success: false }, JSON.stringify(other));
  }
});

test("changing any single character of a cursor makes it invalid, never another page", () => {
  const cursor = encodeSearchCursor(KEY, SCOPE);
  for (let index = 0; index < cursor.length; index += 1) {
    const replacement = cursor[index] === "A" ? "B" : "A";
    const damaged = cursor.slice(0, index) + replacement + cursor.slice(index + 1);
    assert.deepEqual(decodeSearchCursor(damaged, SCOPE), { success: false }, `position ${index}`);
  }
});

test("garbage is refused: empty, not base64url, not JSON, too long, another version", () => {
  const base64 = (value: string) => Buffer.from(value).toString("base64url");
  for (const cursor of [
    "",
    "not a cursor!",
    base64("{"),
    base64("[]"),
    base64(JSON.stringify({ v: 2, k: [KEY.departureAt, KEY.id], s: "x" })),
    "A".repeat(513),
  ]) {
    assert.deepEqual(decodeSearchCursor(cursor, SCOPE), { success: false }, cursor.slice(0, 40));
  }
});
