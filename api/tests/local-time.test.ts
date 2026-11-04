import assert from "node:assert/strict";
import test from "node:test";

import { arrivalDayOffset, localDateOf, toLocalIso } from "../src/flights/local-time.js";

const VIETNAM = "Asia/Ho_Chi_Minh";
const LONDON = "Europe/London";

test("06:00 on 20 November in Vietnam is 23:00 UTC on the 19th: local time and date come from the zone", () => {
  assert.equal(toLocalIso("2026-11-19T23:00:00.000Z", VIETNAM), "2026-11-20T06:00:00+07:00");
  assert.equal(localDateOf("2026-11-19T23:00:00.000Z", VIETNAM), "2026-11-20");
  assert.equal(localDateOf("2026-11-20T16:30:00.000Z", VIETNAM), "2026-11-20"); // 23:30 local, still the 20th
});

test("London's offset follows the zone's rules: +00:00 before the spring change, +01:00 after it, back to +00:00 in autumn", () => {
  assert.equal(toLocalIso("2027-03-28T00:59:00.000Z", LONDON), "2027-03-28T00:59:00+00:00");
  assert.equal(toLocalIso("2027-03-28T01:00:00.000Z", LONDON), "2027-03-28T02:00:00+01:00");
  assert.equal(toLocalIso("2027-10-31T00:59:00.000Z", LONDON), "2027-10-31T01:59:00+01:00");
  assert.equal(toLocalIso("2027-10-31T01:00:00.000Z", LONDON), "2027-10-31T01:00:00+00:00");
});

test("on London's 23-hour day 22:30 UTC is still the 28th, 23:30 UTC is already the 29th", () => {
  assert.equal(localDateOf("2027-03-28T22:30:00.000Z", LONDON), "2027-03-28");
  assert.equal(localDateOf("2027-03-28T23:30:00.000Z", LONDON), "2027-03-29");
});

test("a flight across local midnight arrives +1 (23:00 → 05:00 the next day, both in Vietnam)", () => {
  assert.equal(arrivalDayOffset("2026-11-20T16:00:00.000Z", VIETNAM, "2026-11-20T22:00:00.000Z", VIETNAM), 1);
  assert.equal(toLocalIso("2026-11-20T22:00:00.000Z", VIETNAM), "2026-11-21T05:00:00+07:00");
});

test("each end uses its own zone: a same-day flight is 0, a long eastbound night flight +1, a westbound hop can be −1", () => {
  // SGN 08:00 → HAN 10:00.
  assert.equal(arrivalDayOffset("2026-11-20T01:00:00.000Z", VIETNAM, "2026-11-20T03:00:00.000Z", VIETNAM), 0);
  // LHR 21:00 BST → SGN 15:00 the next day (12 h).
  assert.equal(arrivalDayOffset("2027-06-10T20:00:00.000Z", LONDON, "2027-06-11T08:00:00.000Z", VIETNAM), 1);
  // SGN 02:00 on the 10th → LHR 21:00 BST on the 9th (a one-hour hop, for the arithmetic).
  assert.equal(arrivalDayOffset("2027-06-09T19:00:00.000Z", VIETNAM, "2027-06-09T20:00:00.000Z", LONDON), -1);
});

test("the offset is never a constant: the same UTC hour is 08:00 in January and 09:00 in July in London", () => {
  assert.equal(toLocalIso("2027-01-15T08:00:00.000Z", LONDON), "2027-01-15T08:00:00+00:00");
  assert.equal(toLocalIso("2027-07-15T08:00:00.000Z", LONDON), "2027-07-15T09:00:00+01:00");
});
