import type {
  Booking,
  BookingPassenger,
  HeldSeat,
} from "../../src/bookings/booking-repository.js";
import { BOOKING_REFERENCE_ALPHABET } from "../../src/bookings/booking-reference.js";
import { bookingTotal } from "../../src/bookings/booking-total.js";

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
 * Passengers for seats a hold returned, in the hold's order, each with the
 * seat's price — what CreateBooking pairs them into.
 */
export function passengersFor(
  held: readonly HeldSeat[],
  names: readonly string[] = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan"],
): BookingPassenger[] {
  return held.map(({ seat, fareClass, price }, index) => ({
    name: names[index] ?? `Passenger ${index + 1}`,
    seat,
    fareClass,
    price,
  }));
}

/**
 * A HELD booking with one passenger, as CreateBooking writes it. Pass the
 * passengers of the seats actually claimed (passengersFor); the default has
 * no seat and so no price. `total` is always derived from the passengers,
 * as every reader derives it.
 */
export function makeBooking(
  overrides: Partial<Omit<Booking, "total">> & Pick<Booking, "flightId">,
): Booking {
  const booking = {
    id: crypto.randomUUID(),
    reference: nextBookingReference(),
    ownerAccountId: FIXTURE_ACCOUNT_A,
    passengers: [{ name: "Alice", seat: null, fareClass: null, price: null }],
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "HELD" as const,
    holdExpiresAt: "2026-07-20T00:15:00.000Z",
    ...overrides,
  };
  return { ...booking, total: bookingTotal(booking.passengers) };
}
