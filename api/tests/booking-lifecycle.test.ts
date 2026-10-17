import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNotCancelled,
  effectiveBookingStatus,
  isHoldLapsed,
} from "../src/bookings/booking-lifecycle.js";

const DEADLINE = "2026-07-20T00:15:00.000Z";
const AT_DEADLINE = new Date(DEADLINE);
const JUST_BEFORE = new Date(AT_DEADLINE.getTime() - 1);

test("a hold has lapsed at its deadline, not 1 ms before (BR-BOOK-10)", () => {
  assert.equal(isHoldLapsed(DEADLINE, AT_DEADLINE), true);
  assert.equal(isHoldLapsed(DEADLINE, JUST_BEFORE), false);
});

test("only a lapsed HELD reads EXPIRED; every other status and a valid hold read as stored", () => {
  assert.equal(effectiveBookingStatus("HELD", DEADLINE, AT_DEADLINE), "EXPIRED");
  assert.equal(effectiveBookingStatus("HELD", DEADLINE, JUST_BEFORE), "HELD");
  // A deadline is kept as history after the hold ends; it changes nothing.
  assert.equal(effectiveBookingStatus("CONFIRMED", DEADLINE, AT_DEADLINE), "CONFIRMED");
  assert.equal(effectiveBookingStatus("CANCELLED", DEADLINE, AT_DEADLINE), "CANCELLED");
  // Legacy CONFIRMED bookings have no deadline at all.
  assert.equal(effectiveBookingStatus("CONFIRMED", null, AT_DEADLINE), "CONFIRMED");
});

test("a cancel that matched nothing is already-cancelled or expired; a cancellable booking is a bug, not an outcome", () => {
  assert.deepEqual(classifyNotCancelled("CANCELLED", DEADLINE, AT_DEADLINE), { outcome: "already-cancelled" });
  assert.deepEqual(classifyNotCancelled("EXPIRED", DEADLINE, JUST_BEFORE), { outcome: "expired" });
  assert.deepEqual(classifyNotCancelled("HELD", DEADLINE, AT_DEADLINE), { outcome: "expired" });
  assert.throws(() => classifyNotCancelled("HELD", DEADLINE, JUST_BEFORE), /cancel matched no row/);
  assert.throws(() => classifyNotCancelled("CONFIRMED", null, AT_DEADLINE), /cancel matched no row/);
});
