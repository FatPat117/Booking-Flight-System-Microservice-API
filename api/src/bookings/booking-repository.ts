export type BookingStatus = "active" | "cancelled";

export type Booking = Readonly<{
  id: string;
  flightId: string;
  /** Identity account id (JWT `sub`). Not necessarily a passenger. */
  ownerAccountId: string;
  passengerName: string;
  createdAt: string;
  status: BookingStatus;
  /**
   * Derived: the code of the seat this booking holds ("12C"), null once
   * cancelled (its seat was released). The link lives on the seat
   * (Decision 10); create() does not store this, reads look it up.
   */
  seat: string | null;
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

/**
 * - reserved: `seat` is the allocated seat's code, e.g. "12C"
 * - sold-out: no AVAILABLE seat this caller could take
 * - sales-closed: the flight is not effectively OPEN at `now` (BR-FLT-06)
 */
export type ReserveSeatResult =
  | { outcome: "reserved"; seat: string }
  | { outcome: "sold-out" }
  | { outcome: "sales-closed" }
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
   * Allocate one AVAILABLE seat of the flight to `bookingId` — the lowest
   * row, then letter, that no concurrent caller is taking — in one
   * statement, and only while the flight is bookable at `now`: stored OPEN
   * and more than 1 hour before departure (BR-FLT-06, the same rule as
   * isBookable). `now` comes from the caller so reads and holds use one
   * clock (ADR-008).
   *
   * Called before create(booking): the booking id is generated first and
   * the seat points at it; the storage must accept that order within one
   * transaction (Decision 10).
   */
  reserveSeat(
    flightId: string,
    bookingId: string,
    now: Date,
  ): Promise<ReserveSeatResult>;
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
   * Mark booking cancelled only when still active and inside the scope (OCC),
   * and release its seat (AVAILABLE, no booking) in the same statement — so
   * only the call that wins the active → cancelled transition releases it.
   */
  cancel(
    bookingId: string,
    scope: BookingAccessScope,
  ): Promise<CancelBookingRepositoryResult>;
}>;
