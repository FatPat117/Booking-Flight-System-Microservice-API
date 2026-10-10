import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveFlightStatus,
  FLIGHT_STATUSES,
  isBookable,
  transitionFlight,
  type FlightStatus,
} from "../src/flights/flight-lifecycle.js";

const DEPARTURE = "2027-03-10T10:00:00.000Z";
const at = (iso: string) => new Date(iso);
const FAR_AHEAD = { departureAt: DEPARTURE, now: at("2027-03-01T00:00:00.000Z") };

// Written by hand from domain-model.md's Flight table, not imported from the
// code's table: if the code's table has a wrong row, these disagree.
const ALLOWED: ReadonlyArray<readonly [FlightStatus, FlightStatus]> = [
  ["SCHEDULED", "OPEN"],
  ["SCHEDULED", "CANCELLED"],
  ["OPEN", "CANCELLED"],
  ["CLOSED", "CANCELLED"],
];

function isAllowed(from: FlightStatus, to: FlightStatus): boolean {
  return ALLOWED.some(([a, b]) => a === from && b === to);
}

// Every one of the 25 pairs, so nothing is missed.
for (const from of FLIGHT_STATUSES) {
  for (const to of FLIGHT_STATUSES) {
    const expected = isAllowed(from, to);

    test(`${from} → ${to} is ${expected ? "allowed" : "rejected"}`, () => {
      assert.deepEqual(
        transitionFlight(from, to, FAR_AHEAD),
        expected ? { ok: true } : { ok: false, reason: "NOT_ALLOWED" },
      );
    });
  }
}

// The pairs whose loss would hurt most, spelled out on their own.
test("a cancelled flight cannot be reopened", () => {
  assert.equal(transitionFlight("CANCELLED", "OPEN", FAR_AHEAD).ok, false);
});

test("a departed flight cannot be reopened or cancelled", () => {
  assert.equal(transitionFlight("DEPARTED", "OPEN", FAR_AHEAD).ok, false);
  assert.equal(transitionFlight("DEPARTED", "CANCELLED", FAR_AHEAD).ok, false);
});

test("reopening after sales closed is forbidden (would bypass BR-FLT-06)", () => {
  assert.equal(transitionFlight("CLOSED", "OPEN", FAR_AHEAD).ok, false);
});

test("an open flight cannot go back to SCHEDULED", () => {
  assert.equal(transitionFlight("OPEN", "SCHEDULED", FAR_AHEAD).ok, false);
});

test("nobody can set a derived status: CLOSED and DEPARTED are never targets", () => {
  for (const from of FLIGHT_STATUSES) {
    for (const to of ["CLOSED", "DEPARTED"] as const) {
      assert.equal(transitionFlight(from, to, FAR_AHEAD).ok, false, `${from} → ${to}`);
    }
  }
});

test("opening needs departure more than 1 hour away (US-FLT-02)", () => {
  const justOverAnHour = {
    departureAt: DEPARTURE,
    now: at("2027-03-10T08:59:59.999Z"),
  };
  const exactlyAnHour = { departureAt: DEPARTURE, now: at("2027-03-10T09:00:00.000Z") };

  assert.deepEqual(transitionFlight("SCHEDULED", "OPEN", justOverAnHour), { ok: true });
  assert.deepEqual(transitionFlight("SCHEDULED", "OPEN", exactlyAnHour), {
    ok: false,
    reason: "DEPARTURE_TOO_SOON",
  });
});

test("effective status: OPEN reads CLOSED from exactly 1 hour before departure", () => {
  assert.equal(effectiveFlightStatus("OPEN", DEPARTURE, at("2027-03-10T08:59:59.999Z")), "OPEN");
  assert.equal(effectiveFlightStatus("OPEN", DEPARTURE, at("2027-03-10T09:00:00.000Z")), "CLOSED");
});

test("effective status: anything not cancelled reads DEPARTED from departure time", () => {
  const departed = at(DEPARTURE);

  assert.equal(effectiveFlightStatus("OPEN", DEPARTURE, departed), "DEPARTED");
  assert.equal(effectiveFlightStatus("SCHEDULED", DEPARTURE, departed), "DEPARTED");
  assert.equal(
    effectiveFlightStatus("OPEN", DEPARTURE, at("2027-03-10T09:59:59.999Z")),
    "CLOSED",
  );
});

test("effective status: SCHEDULED stays SCHEDULED inside the last hour (it never opened)", () => {
  assert.equal(
    effectiveFlightStatus("SCHEDULED", DEPARTURE, at("2027-03-10T09:30:00.000Z")),
    "SCHEDULED",
  );
});

test("effective status: CANCELLED stays CANCELLED, even after departure time", () => {
  assert.equal(
    effectiveFlightStatus("CANCELLED", DEPARTURE, at("2027-04-01T00:00:00.000Z")),
    "CANCELLED",
  );
});

test("bookable only while effectively OPEN (BR-FLT-06)", () => {
  const early = at("2027-03-01T00:00:00.000Z");
  const lastHour = at("2027-03-10T09:30:00.000Z");

  assert.equal(isBookable("OPEN", DEPARTURE, early), true);
  assert.equal(isBookable("OPEN", DEPARTURE, lastHour), false);
  assert.equal(isBookable("SCHEDULED", DEPARTURE, early), false);
  assert.equal(isBookable("CANCELLED", DEPARTURE, early), false);
});

test("transitions are judged on the effective status: an OPEN flight in its last hour can no longer be reopened", () => {
  const lastHour = at("2027-03-10T09:30:00.000Z");
  const effective = effectiveFlightStatus("OPEN", DEPARTURE, lastHour);

  assert.equal(effective, "CLOSED");
  assert.deepEqual(transitionFlight(effective, "OPEN", { departureAt: DEPARTURE, now: lastHour }), {
    ok: false,
    reason: "NOT_ALLOWED",
  });
});
