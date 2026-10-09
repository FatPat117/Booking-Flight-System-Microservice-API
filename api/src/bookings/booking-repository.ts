export type BookingStatus = "active" | "cancelled";

export type Booking = Readonly<{
  id: string;
  flightId: string;
  /** Identity account id (JWT `sub`). Not necessarily a passenger. */
  ownerAccountId: string;
  passengerName: string;
  createdAt: string;
  status: BookingStatus;
}>;

/**
 * Whose bookings a caller may see or change (BR-AUTH-02/03).
 *
 * A discriminated union rather than `ownerAccountId?: string`, so "no owner
 * filter" can only be asked for explicitly (`admin`) and never happens by
 * passing `undefined`.
 */
export type BookingAccessScope =
  | Readonly<{ kind: "owner"; accountId: string }>
  | Readonly<{ kind: "admin" }>;

export type BookingPageRequest = {
  limit: number;
  offset: number;
};

/** totalItems counts every booking visible in the scope, not the current page. */
export type BookingPage = {
  items: Booking[];
  totalItems: number;
};

export type ReserveSeatResult =
  | { outcome: "reserved" }
  | { outcome: "sold-out" }
  | { outcome: "flight-not-found" };

export type CancelBookingRepositoryResult =
  | { outcome: "cancelled"; flightId: string }
  | { outcome: "already-cancelled" }
  | { outcome: "not-found" };

/**
 * Object-level authorization lives here, in the queries: every method that
 * reads or changes an existing booking takes a BookingAccessScope and applies
 * it to *every* query it runs — including the follow-up read that only picks
 * an error outcome. A booking outside the scope is indistinguishable from one
 * that does not exist (`undefined` / `not-found`), never `already-cancelled`.
 *
 * Does not know about JWTs, roles or HTTP status codes.
 */
export type BookingRepository = Readonly<{
  /**
   * Decrement availableSeats atomically — no separate read-then-write.
   */
  reserveSeat(flightId: string): Promise<ReserveSeatResult>;
  create(booking: Booking): Promise<void>;
  findById(
    bookingId: string,
    scope: BookingAccessScope,
  ): Promise<Booking | undefined>;
  /** Newest first (createdAt DESC, then id DESC as a stable tie-breaker). */
  findPage(
    scope: BookingAccessScope,
    request: BookingPageRequest,
  ): Promise<BookingPage>;
  /**
   * Mark booking cancelled only when still active and inside the scope (OCC).
   * Seat release stays in the use case — only after a successful first cancel.
   */
  cancel(
    bookingId: string,
    scope: BookingAccessScope,
  ): Promise<CancelBookingRepositoryResult>;
  /**
   * Increment availableSeats by 1. Call only after cancel() returns cancelled.
   */
  releaseSeat(flightId: string): Promise<void>;
}>;
