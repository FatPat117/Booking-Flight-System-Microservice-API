import assert from "node:assert/strict";
import test from "node:test";

import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
} from "../src/bookings/booking-repository.js";
import { createGetBookingByReference } from "../src/bookings/get-booking-by-reference.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
} from "./fakes/in-memory.js";
import { makeBooking } from "./fixtures/bookings.js";
import { makeFlight } from "./fixtures/flights.js";

const FLIGHT_ID = "f1f1f1f1-0000-4000-8000-000000000001";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const SCOPE_A: BookingAccessScope = { kind: "owner", accountId: ACCOUNT_A };
const SCOPE_B: BookingAccessScope = { kind: "owner", accountId: ACCOUNT_B };
const REFERENCE = "K7Q4PZ";

async function createRuntimeWithBookingOfA() {
  const flights = createInMemoryFlightStore();
  await createInMemoryFlightRepository(flights).create(
    makeFlight({ id: FLIGHT_ID }),
  );
  const inner = createInMemoryBookingRepository({ flights });
  const lookups: string[] = [];
  const bookingRepository: BookingRepository = {
    ...inner,
    async findByReference(reference, scope) {
      lookups.push(reference);
      return inner.findByReference(reference, scope);
    },
  };

  const booking: Booking = makeBooking({
    flightId: FLIGHT_ID,
    ownerAccountId: ACCOUNT_A,
    reference: REFERENCE,
  });
  await bookingRepository.create(booking);

  return {
    // Before the fixture hold lapses (2026-07-20T00:15Z); the lapsed read
    // is covered in get-booking.test.ts and bookings.api.test.ts.
    getBookingByReference: createGetBookingByReference({
      bookingRepository,
      getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
    }),
    booking,
    lookups,
  };
}

test("the owner gets their booking by its reference", async () => {
  const { getBookingByReference, booking } = await createRuntimeWithBookingOfA();

  assert.deepEqual(await getBookingByReference(REFERENCE, SCOPE_A), {
    outcome: "found",
    booking,
  });
});

test("another account's reference is not-found, same as a missing one (BR-AUTH-02)", async () => {
  const { getBookingByReference } = await createRuntimeWithBookingOfA();

  const otherAccount = await getBookingByReference(REFERENCE, SCOPE_B);
  const missing = await getBookingByReference("ZZZZZZ", SCOPE_B);

  assert.deepEqual(otherAccount, { outcome: "not-found" });
  assert.deepEqual(otherAccount, missing);
});

test("an admin gets any account's booking by reference (BR-AUTH-03)", async () => {
  const { getBookingByReference, booking } = await createRuntimeWithBookingOfA();

  assert.deepEqual(await getBookingByReference(REFERENCE, { kind: "admin" }), {
    outcome: "found",
    booking,
  });
});

test("a malformed reference is not-found and never reaches the repository", async () => {
  const { getBookingByReference, lookups } = await createRuntimeWithBookingOfA();

  // Lower case, the ambiguous 0/O and 1/I, and wrong lengths are not codes.
  for (const reference of ["k7q4pz", "K7Q4P0", "K7Q4P1", "K7Q4P", "K7Q4PZZ", ""]) {
    assert.deepEqual(await getBookingByReference(reference, SCOPE_A), {
      outcome: "not-found",
    });
  }
  assert.deepEqual(lookups, []);
});
