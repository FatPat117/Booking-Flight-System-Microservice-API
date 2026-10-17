import { isUuid } from "../types.js";
import { withEffectiveStatus } from "./booking-lifecycle.js";
import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
} from "./booking-repository.js";

export type GetBookingResult =
  | { outcome: "found"; booking: Booking }
  | { outcome: "not-found" };

/**
 * One booking, as visible from `scope`. Another account's booking and a
 * malformed id are both not-found — the same answer as a missing one
 * (BR-AUTH-02). A lapsed hold reads EXPIRED before the job sweeps it
 * (Decision 12).
 */
export type GetBooking = (
  bookingId: string,
  scope: BookingAccessScope,
) => Promise<GetBookingResult>;

export function createGetBooking(dependencies: {
  bookingRepository: BookingRepository;
  getCurrentTime: () => Date;
}): GetBooking {
  const { bookingRepository, getCurrentTime } = dependencies;

  return async (bookingId, scope) => {
    if (!isUuid(bookingId)) {
      return { outcome: "not-found" };
    }

    const booking = await bookingRepository.findById(bookingId, scope);

    return booking === undefined
      ? { outcome: "not-found" }
      : { outcome: "found", booking: withEffectiveStatus(booking, getCurrentTime()) };
  };
}
