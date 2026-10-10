import assert from "node:assert/strict";
import test from "node:test";

import { formatSeatPosition } from "../src/aircraft/seat-position.js";
import {
  expandSeatLayout,
  SEAT_LAYOUT_LIMITS,
} from "../src/aircraft/seat-layout.js";
import type { ValidationIssue } from "../src/types.js";

const A321_LAYOUT = {
  cabins: [
    { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
    { fareClass: "ECONOMY", fromRow: 3, toRow: 7, seatLetters: "ABCDEF" },
  ],
};

function issuesOf(input: unknown): ValidationIssue[] {
  const result = expandSeatLayout(input);
  assert.equal(result.success, false);
  return result.success ? [] : result.issues;
}

test("a two-cabin layout expands into one seat per position (US-REF-02: 38 seats)", () => {
  const result = expandSeatLayout(A321_LAYOUT);

  assert.equal(result.success, true);
  if (!result.success) return;

  assert.equal(result.value.length, 38);
  assert.equal(
    result.value.filter((seat) => seat.fareClass === "BUSINESS").length,
    8,
  );
  assert.deepEqual(result.value[0], {
    position: { row: 1, letter: "A" },
    fareClass: "BUSINESS",
  });
  assert.deepEqual(result.value.at(-1), {
    position: { row: 7, letter: "F" },
    fareClass: "ECONOMY",
  });

  const codes = result.value.map((seat) => formatSeatPosition(seat.position));
  assert.equal(new Set(codes).size, codes.length);
});

test("rows may skip numbers between cabins (no row 13)", () => {
  const result = expandSeatLayout({
    cabins: [
      { fareClass: "ECONOMY", fromRow: 10, toRow: 12, seatLetters: "AB" },
      { fareClass: "ECONOMY", fromRow: 14, toRow: 15, seatLetters: "AB" },
    ],
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.value.length, 10);
});

test("overlapping cabins are rejected naming the duplicated seat (BR-REF-03)", () => {
  const issues = issuesOf({
    cabins: [
      { fareClass: "BUSINESS", fromRow: 1, toRow: 12, seatLetters: "ACDF" },
      { fareClass: "ECONOMY", fromRow: 12, toRow: 30, seatLetters: "ABCDEF" },
    ],
  });

  assert.deepEqual(issues, [
    {
      field: "seatLayout.cabins[1]",
      code: "CABIN_ROWS_OVERLAP",
      message: "row 12 also belongs to cabins[0] (seat 12A is listed twice)",
    },
  ]);
});

test("a row in two cabins is rejected even when their letters differ (BR-REF-06)", () => {
  const issues = issuesOf({
    cabins: [
      { fareClass: "BUSINESS", fromRow: 1, toRow: 3, seatLetters: "AC" },
      { fareClass: "ECONOMY", fromRow: 2, toRow: 5, seatLetters: "DF" },
    ],
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "CABIN_ROWS_OVERLAP");
  assert.match(issues[0]?.message ?? "", /rows 2–3/);
});

test("every problem in every cabin is reported at once, not one per request", () => {
  const issues = issuesOf({
    cabins: [
      { fareClass: "FIRST", fromRow: 5, toRow: 3, seatLetters: "AAB" },
      { fareClass: "ECONOMY", fromRow: 0, toRow: 4, seatLetters: "AZ" },
    ],
  });

  assert.deepEqual(
    issues.map((issue) => `${issue.field} ${issue.code}`),
    [
      "seatLayout.cabins[0].fareClass INVALID_FARE_CLASS",
      "seatLayout.cabins[0].toRow INVALID_ROW_RANGE",
      "seatLayout.cabins[0].seatLetters DUPLICATE_SEAT_LETTER",
      "seatLayout.cabins[1].fromRow INVALID_ROW",
      "seatLayout.cabins[1].seatLetters INVALID_SEAT_LETTERS",
    ],
  );
});

test("missing or empty cabins are rejected", () => {
  for (const input of [undefined, {}, { cabins: "x" }, { cabins: [] }]) {
    const issues = issuesOf(input);
    assert.equal(issues.length, 1, JSON.stringify(input));
  }
});

test("a layout over the seat limit is rejected with the total computed from the input", () => {
  // 10 letters × 99 rows = 990 seats, every field individually valid.
  const issues = issuesOf({
    cabins: [
      { fareClass: "ECONOMY", fromRow: 1, toRow: 99, seatLetters: "ABCDEFGHJK" },
    ],
  });

  assert.deepEqual(issues, [
    {
      field: "seatLayout.cabins",
      code: "TOO_MANY_SEATS",
      message: `the layout has 990 seats; the maximum is ${SEAT_LAYOUT_LIMITS.maxSeats}`,
    },
  ]);
});

test("input amplification: a tiny request asking for a billion rows is rejected before expansion", () => {
  const issues = issuesOf({
    cabins: [
      { fareClass: "ECONOMY", fromRow: 1, toRow: 1_000_000_000, seatLetters: "ABCDEF" },
    ],
  });

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["INVALID_ROW"],
  );
});

test("input amplification: a huge cabins array is rejected by its length, without walking it", () => {
  const cabins = Array.from({ length: 100_000 }, () => "not a cabin");
  const issues = issuesOf({ cabins });

  // One issue: the elements (each invalid) were never looked at.
  assert.deepEqual(issues.map((issue) => issue.code), ["INVALID_CABIN_COUNT"]);
});

test("input amplification: a huge seatLetters string is rejected by its length", () => {
  const issues = issuesOf({
    cabins: [
      { fareClass: "ECONOMY", fromRow: 1, toRow: 2, seatLetters: "A".repeat(1_000_000) },
    ],
  });

  assert.deepEqual(issues.map((issue) => issue.code), ["INVALID_SEAT_LETTERS"]);
});

test("issue paths use the caller's field prefix", () => {
  const result = expandSeatLayout({ cabins: [] }, "layout");

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.issues[0]?.field, "layout.cabins");
});
