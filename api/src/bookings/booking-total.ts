import { type Money, sumMoney } from "../money/money.js";
import type { BookingPassenger } from "./booking-repository.js";

/**
 * Booking.total (BR-BOOK-03): the sum of the passengers' prices. The one
 * place it is computed — CreateBooking, the Postgres adapter and the fake
 * all call this, so a stored copy can never disagree with the prices.
 *
 * A passenger without a price (cancelled before Day 48A, seat unknown)
 * adds nothing.
 */
export function bookingTotal(passengers: readonly BookingPassenger[]): Money {
  return sumMoney(
    passengers.flatMap(({ price }) => (price === null ? [] : [price])),
    "VND",
  );
}
