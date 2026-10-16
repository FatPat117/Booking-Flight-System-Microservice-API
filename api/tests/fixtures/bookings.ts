import type { Booking } from "../../src/bookings/booking-repository.js";
import { BOOKING_REFERENCE_ALPHABET } from "../../src/bookings/booking-reference.js";

export const FIXTURE_ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

let referenceSequence = 0;

/**
 * A valid, never repeated reference per call (a counter written in the
 * reference alphabet), so fixture bookings never collide by accident — a
 * test that wants a collision passes the same reference on purpose.
 */
export function nextBookingReference(): string {
  let value = (referenceSequence += 1);
  let reference = "";
  for (let i = 0; i < 6; i += 1) {
    reference = BOOKING_REFERENCE_ALPHABET[value % 32] + reference;
    value = Math.floor(value / 32);
  }
  return reference;
}

/**
 * A HELD booking with one passenger, as CreateBooking writes it. `seat` is
 * the passenger's display copy: pass the seat that was actually claimed.
 */
export function makeBooking(
  overrides: Partial<Booking> & Pick<Booking, "flightId">,
): Booking {
  return {
    id: crypto.randomUUID(),
    reference: nextBookingReference(),
    ownerAccountId: FIXTURE_ACCOUNT_A,
    passengers: [{ name: "Alice", seat: null }],
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "HELD",
    holdExpiresAt: "2026-07-20T00:15:00.000Z",
    ...overrides,
  };
}
