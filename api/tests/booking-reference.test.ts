import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOKING_REFERENCE_ALPHABET,
  generateBookingReference,
  isBookingReference,
} from "../src/bookings/booking-reference.js";

test("the alphabet has 32 distinct characters and none of 0, O, 1, I", () => {
  assert.equal(BOOKING_REFERENCE_ALPHABET.length, 32);
  assert.equal(new Set(BOOKING_REFERENCE_ALPHABET).size, 32);
  for (const ambiguous of ["0", "O", "1", "I"]) {
    assert.ok(!BOOKING_REFERENCE_ALPHABET.includes(ambiguous), ambiguous);
  }
});

test("generateBookingReference maps each draw to the alphabet, 6 characters", () => {
  const draws = [0, 31, 8, 13, 24, 1];
  let call = 0;
  const reference = generateBookingReference((max) => {
    assert.equal(max, 32);
    return draws[call++] ?? 0;
  });

  assert.equal(reference, "A9JP2B");
  assert.equal(call, 6);
});

test("generated references are valid references (default crypto source)", () => {
  for (let i = 0; i < 1000; i += 1) {
    const reference = generateBookingReference();
    assert.ok(isBookingReference(reference), reference);
  }
});

test("isBookingReference rejects ambiguous characters, lower case, wrong length and non-strings", () => {
  for (const value of ["K7Q4PZ", "ABCDEF", "234567"]) {
    assert.ok(isBookingReference(value), value);
  }
  for (const value of ["K7Q4P0", "K7Q4PO", "K7Q4P1", "K7Q4PI", "k7q4pz", "K7Q4P", "K7Q4PZZ", "", 123456, null]) {
    assert.ok(!isBookingReference(value), String(value));
  }
});
