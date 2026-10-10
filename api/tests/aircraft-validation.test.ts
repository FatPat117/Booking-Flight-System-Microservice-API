import assert from "node:assert/strict";
import test from "node:test";

import { validateRegisterAircraftInput } from "../src/aircraft/aircraft-validation.js";

const VALID = {
  registration: "VN-A321",
  model: "Airbus A321",
  seatLayout: {
    cabins: [
      { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
      { fareClass: "ECONOMY", fromRow: 3, toRow: 7, seatLetters: "ABCDEF" },
    ],
  },
};

function codesFor(input: unknown): string[] {
  const result = validateRegisterAircraftInput(input);
  return result.success
    ? []
    : result.issues.map((issue) => `${issue.field} ${issue.code}`);
}

test("a valid aircraft passes with an upper-cased registration and its expanded seats", () => {
  const result = validateRegisterAircraftInput({
    ...VALID,
    registration: " vn-a321 ",
    model: " Airbus A321 ",
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.value.registration, "VN-A321");
  assert.equal(result.value.model, "Airbus A321");
  assert.equal(result.value.seats.length, 38);
});

test("registrations without a hyphen are accepted (N12345)", () => {
  assert.deepEqual(codesFor({ ...VALID, registration: "N12345" }), []);
});

test("a malformed registration is rejected", () => {
  for (const registration of ["VN_A321", "VN--A321", "-A321", "VN-A32100"]) {
    assert.deepEqual(
      codesFor({ ...VALID, registration }),
      ["registration INVALID_REGISTRATION"],
      registration,
    );
  }
});

test("field and layout problems are reported together", () => {
  assert.deepEqual(
    codesFor({
      registration: "",
      model: "x".repeat(51),
      seatLayout: {
        cabins: [{ fareClass: "ECONOMY", fromRow: 1, toRow: 2, seatLetters: "AA" }],
      },
    }),
    [
      "registration INVALID_STRING",
      "model TOO_LONG",
      "seatLayout.cabins[0].seatLetters DUPLICATE_SEAT_LETTER",
    ],
  );
});

test("a missing seat layout is rejected", () => {
  assert.deepEqual(
    codesFor({ registration: "VN-A321", model: "Airbus A321" }),
    ["seatLayout INVALID_SEAT_LAYOUT"],
  );
});
