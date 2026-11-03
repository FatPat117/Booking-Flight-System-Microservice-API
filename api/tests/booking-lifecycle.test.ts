import assert from "node:assert/strict";
import test from "node:test";

import {
  cancellableUntil,
  classifyNotCancelled,
  effectiveBookingStatus,
  isCancellationWindowOpen,
  isHoldLapsed,
} from "../src/bookings/booking-lifecycle.js";

const DEADLINE = "2026-07-20T00:15:00.000Z";
const AT_DEADLINE = new Date(DEADLINE);
const JUST_BEFORE = new Date(AT_DEADLINE.getTime() - 1);
/** Far enough that the 24 h window never closes in the BR-BOOK-10 cases. */
const FAR_DEPARTURE = "2027-01-01T00:00:00.000Z";

const DEPARTURE = "2026-08-01T10:00:00.000Z";
const WINDOW_CLOSES = new Date("2026-07-31T10:00:00.000Z");

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
  assert.deepEqual(classifyNotCancelled("CANCELLED", DEADLINE, FAR_DEPARTURE, AT_DEADLINE), { outcome: "already-cancelled" });
  assert.deepEqual(classifyNotCancelled("EXPIRED", DEADLINE, FAR_DEPARTURE, JUST_BEFORE), { outcome: "expired" });
  assert.deepEqual(classifyNotCancelled("HELD", DEADLINE, FAR_DEPARTURE, AT_DEADLINE), { outcome: "expired" });
  assert.throws(() => classifyNotCancelled("HELD", DEADLINE, FAR_DEPARTURE, JUST_BEFORE), /cancel matched no row/);
  assert.throws(() => classifyNotCancelled("CONFIRMED", null, FAR_DEPARTURE, AT_DEADLINE), /cancel matched no row/);
});

test("the 24 h window is open 1 ms before departure − 24 h and closed at exactly that instant (BR-BOOK-06)", () => {
  assert.equal(cancellableUntil(DEPARTURE), WINDOW_CLOSES.toISOString());
  assert.equal(isCancellationWindowOpen(DEPARTURE, new Date(WINDOW_CLOSES.getTime() - 1)), true);
  assert.equal(isCancellationWindowOpen(DEPARTURE, WINDOW_CLOSES), false);
  assert.equal(isCancellationWindowOpen(DEPARTURE, new Date(WINDOW_CLOSES.getTime() + 1)), false);
});

test("a CONFIRMED cancel that matched nothing inside 24 h is window-closed with the deadline; outside it, a bug", () => {
  assert.deepEqual(classifyNotCancelled("CONFIRMED", null, DEPARTURE, WINDOW_CLOSES), {
    outcome: "cancellation-window-closed",
    cancellableUntil: "2026-07-31T10:00:00.000Z",
  });
  assert.throws(
    () => classifyNotCancelled("CONFIRMED", null, DEPARTURE, new Date(WINDOW_CLOSES.getTime() - 1)),
    /cancel matched no row/,
  );
  // A HELD booking is limited by its hold only, never by the 24 h window.
  assert.throws(
    () => classifyNotCancelled("HELD", "2026-07-31T10:15:00.000Z", DEPARTURE, WINDOW_CLOSES),
    /cancel matched no row/,
  );
});
