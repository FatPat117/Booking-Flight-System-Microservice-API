import type { Booking, BookingStatus } from "./booking-repository.js";

/**
 * BR-BOOK-10: at `now`, a hold whose deadline is `<= now` has lapsed. The
 * one place the boundary is written in TypeScript; the SQL repeats it as
 * `hold_expires_at <= $now` (expiry) and `> $now` (cancel), and the booking
 * repository contract pins both sides at the exact instant.
 */
export function isHoldLapsed(holdExpiresAt: string, now: Date): boolean {
  return new Date(holdExpiresAt).getTime() <= now.getTime();
}

/**
 * Decision 12: between the deadline and the expiry job's next run the row
 * still says HELD. Every read shows it as EXPIRED, the way a flight's CLOSED
 * is derived (effectiveFlightStatus) — the owner never sees a hold that is
 * already over.
 */
export function effectiveBookingStatus(
  status: BookingStatus,
  holdExpiresAt: string | null,
  now: Date,
): BookingStatus {
  if (status === "HELD" && holdExpiresAt !== null && isHoldLapsed(holdExpiresAt, now)) {
    return "EXPIRED";
  }
  return status;
}

/** BR-BOOK-06: a CONFIRMED booking cannot be cancelled within this of departure. */
export const CANCELLATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The last instant (exclusive) a CONFIRMED booking can be cancelled. */
export function cancellableUntil(departureAt: string): string {
  return new Date(new Date(departureAt).getTime() - CANCELLATION_WINDOW_MS).toISOString();
}

/**
 * BR-BOOK-06, the same shape as BR-BOOK-10: at `now` a CONFIRMED booking is
 * cancellable when `departure − 24 h > now`; exactly 24 h before is already
 * closed. The SQL repeats it as `departure_at - interval '24 hours' > $now`,
 * and the booking repository contract pins both sides at the exact instant.
 */
export function isCancellationWindowOpen(departureAt: string, now: Date): boolean {
  return new Date(cancellableUntil(departureAt)).getTime() > now.getTime();
}

/**
 * Why a cancel matched no row, for a booking the caller can see — shared
 * by the Postgres adapter's follow-up read and the fake. A lapsed HELD
 * counts as expired (BR-BOOK-10), the same answer as a stored EXPIRED; a
 * CONFIRMED one inside 24 h of departure is past its window (BR-BOOK-06).
 */
export function classifyNotCancelled(
  status: BookingStatus,
  holdExpiresAt: string | null,
  departureAt: string,
  now: Date,
):
  | { outcome: "already-cancelled" }
  | { outcome: "expired" }
  | { outcome: "cancellation-window-closed"; cancellableUntil: string } {
  const effective = effectiveBookingStatus(status, holdExpiresAt, now);

  if (effective === "CANCELLED") {
    return { outcome: "already-cancelled" };
  }
  if (effective === "EXPIRED") {
    return { outcome: "expired" };
  }
  if (effective === "CONFIRMED" && !isCancellationWindowOpen(departureAt, now)) {
    return {
      outcome: "cancellation-window-closed",
      cancellableUntil: cancellableUntil(departureAt),
    };
  }
  // A cancellable booking the UPDATE did not match: the WHERE and this
  // function disagree, a bug to surface rather than an outcome to invent.
  throw new Error(`Booking is ${effective} but cancel matched no row`);
}

/** The booking as reads return it: stored fields, effective status. */
export function withEffectiveStatus(booking: Booking, now: Date): Booking {
  const status = effectiveBookingStatus(booking.status, booking.holdExpiresAt, now);
  return status === booking.status ? booking : { ...booking, status };
}
