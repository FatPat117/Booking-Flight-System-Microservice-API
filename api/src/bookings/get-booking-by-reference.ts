import { withEffectiveStatus } from "./booking-lifecycle.js";
import { isBookingReference } from "./booking-reference.js";
import type {
  BookingAccessScope,
  BookingRepository,
} from "./booking-repository.js";
import type { GetBookingResult } from "./get-booking.js";

/**
 * US-BOOK-04: one booking by the code its owner wrote down. Like GetBooking,
 * another account's reference and a malformed one are both not-found
 * (BR-AUTH-02) — a reference is guessable in a way a UUID is not, so the
 * scope check is what keeps it private, not the code's secrecy. A lapsed
 * hold reads EXPIRED (Decision 12).
 */
export type GetBookingByReference = (
  reference: string,
  scope: BookingAccessScope,
) => Promise<GetBookingResult>;

export function createGetBookingByReference(dependencies: {
  bookingRepository: BookingRepository;
  getCurrentTime: () => Date;
}): GetBookingByReference {
  const { bookingRepository, getCurrentTime } = dependencies;

  return async (reference, scope) => {
    if (!isBookingReference(reference)) {
      return { outcome: "not-found" };
    }

    const booking = await bookingRepository.findByReference(reference, scope);

    return booking === undefined
      ? { outcome: "not-found" }
      : { outcome: "found", booking: withEffectiveStatus(booking, getCurrentTime()) };
  };
}
