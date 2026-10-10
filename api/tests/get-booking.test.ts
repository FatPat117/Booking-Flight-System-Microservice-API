import assert from "node:assert/strict";
import test from "node:test";

import type {
  Booking,
  BookingAccessScope,
} from "../src/bookings/booking-repository.js";
import { createGetBooking } from "../src/bookings/get-booking.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
} from "./fakes/in-memory.js";
import { makeFlight } from "./fixtures/flights.js";

const FLIGHT_ID = "f1f1f1f1-0000-4000-8000-000000000001";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const SCOPE_A: BookingAccessScope = { kind: "owner", accountId: ACCOUNT_A };
const SCOPE_B: BookingAccessScope = { kind: "owner", accountId: ACCOUNT_B };

async function createRuntimeWithBookingOfA() {
  const flights = createInMemoryFlightStore();
  await createInMemoryFlightRepository(flights).create(
    makeFlight({ id: FLIGHT_ID }),
  );
  const bookingRepository = createInMemoryBookingRepository({ flights });

  const booking: Booking = {
    id: "b0b0b0b0-0000-4000-8000-000000000001",
    flightId: FLIGHT_ID,
    ownerAccountId: ACCOUNT_A,
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active",
  };
  await bookingRepository.create(booking);

  return { getBooking: createGetBooking({ bookingRepository }), booking };
}

test("the owner gets their booking", async () => {
  const { getBooking, booking } = await createRuntimeWithBookingOfA();

  assert.deepEqual(await getBooking(booking.id, SCOPE_A), {
    outcome: "found",
    booking,
  });
});

test("another account's booking is not-found, same as a missing one (BR-AUTH-02)", async () => {
  const { getBooking, booking } = await createRuntimeWithBookingOfA();

  const otherAccount = await getBooking(booking.id, SCOPE_B);
  const missing = await getBooking("c0ffee00-0000-4000-8000-000000000000", SCOPE_B);

  assert.deepEqual(otherAccount, { outcome: "not-found" });
  assert.deepEqual(otherAccount, missing);
});

test("an admin gets any account's booking (BR-AUTH-03)", async () => {
  const { getBooking, booking } = await createRuntimeWithBookingOfA();

  assert.deepEqual(await getBooking(booking.id, { kind: "admin" }), {
    outcome: "found",
    booking,
  });
});

test("a malformed booking id is not-found", async () => {
  const { getBooking } = await createRuntimeWithBookingOfA();

  assert.deepEqual(await getBooking("not-a-uuid", SCOPE_A), { outcome: "not-found" });
});
