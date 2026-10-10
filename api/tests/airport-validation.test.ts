import assert from "node:assert/strict";
import test from "node:test";

import {
  isIanaTimeZone,
  validateRegisterAirportInput,
} from "../src/airports/airport-validation.js";

const VALID = {
  code: "DAD",
  name: "Da Nang International",
  city: "Da Nang",
  timeZone: "Asia/Ho_Chi_Minh",
};

function codesFor(input: unknown): string[] {
  const result = validateRegisterAirportInput(input);
  return result.success
    ? []
    : result.issues.map((issue) => `${issue.field} ${issue.code}`);
}

test("a valid airport passes with trimmed text and an upper-cased code", () => {
  const result = validateRegisterAirportInput({
    ...VALID,
    code: " dad ",
    name: "  Da Nang International ",
  });

  assert.deepEqual(result, {
    success: true,
    value: { ...VALID },
  });
});

test("a code that is not exactly 3 letters is rejected (US-REF-01: DA1)", () => {
  for (const code of ["DA1", "DA", "DANA", "D-D"]) {
    assert.deepEqual(codesFor({ ...VALID, code }), ["code INVALID_AIRPORT_CODE"], code);
  }
});

test("an unknown time zone or an offset is rejected (BR-REF-04)", () => {
  for (const timeZone of ["Asia/Not_A_Zone", "+07:00", "GMT+7", "EST", "asia/ho_chi_minh"]) {
    assert.deepEqual(
      codesFor({ ...VALID, timeZone }),
      ["timeZone INVALID_TIME_ZONE"],
      timeZone,
    );
  }
});

test("IANA names are accepted whether canonical or an alias, and stored as given", () => {
  // This Node's ICU treats Asia/Saigon as canonical and Asia/Ho_Chi_Minh as
  // its alias; both are valid IANA names (validated on write only).
  for (const timeZone of [
    "Asia/Ho_Chi_Minh",
    "Asia/Saigon",
    "Europe/London",
    "America/Argentina/Buenos_Aires",
    "Etc/GMT+7",
    "UTC",
  ]) {
    assert.equal(isIanaTimeZone(timeZone), true, timeZone);
  }

  const result = validateRegisterAirportInput(VALID);
  assert.equal(result.success && result.value.timeZone, "Asia/Ho_Chi_Minh");
});

test("every missing field is reported at once", () => {
  assert.deepEqual(codesFor({}), [
    "code INVALID_STRING",
    "name INVALID_STRING",
    "city INVALID_STRING",
    "timeZone INVALID_STRING",
  ]);
});

test("overlong text is rejected", () => {
  assert.deepEqual(codesFor({ ...VALID, name: "x".repeat(101) }), [
    "name TOO_LONG",
  ]);
});

test("a non-object body is rejected", () => {
  assert.deepEqual(codesFor(["DAD"]), ["body INVALID_BODY"]);
});
