import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSeatPosition,
  parseSeatPosition,
} from "../src/aircraft/seat-position.js";

test("a valid seat code parses into row and letter", () => {
  assert.deepEqual(parseSeatPosition("12A"), { row: 12, letter: "A" });
  assert.deepEqual(parseSeatPosition("1K"), { row: 1, letter: "K" });
  assert.deepEqual(parseSeatPosition("99C"), { row: 99, letter: "C" });
});

test("format(parse(code)) returns the same code for every valid position", () => {
  for (let row = 1; row <= 99; row += 1) {
    for (const letter of "ABCDEFGHIJK") {
      const code = `${row}${letter}`;
      const position = parseSeatPosition(code);

      assert.ok(position, code);
      assert.equal(formatSeatPosition(position), code);
    }
  }
});

test("malformed seat codes are rejected, including lower case and out-of-range rows", () => {
  for (const code of ["0A", "12", "A12", "12AA", "12a", "12L", "100A", "012A", " 12A", ""]) {
    assert.equal(parseSeatPosition(code), undefined, JSON.stringify(code));
  }
});
