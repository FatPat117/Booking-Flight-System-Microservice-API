import type { FareClass } from "../aircraft/seat-layout.js";
import type { SeatPosition } from "../aircraft/seat-position.js";
import type { Money } from "../money/money.js";

/** domain-model "Lifecycles → Booking" (Decision 11). */
export type BookingStatus = "HELD" | "CONFIRMED" | "CANCELLED" | "EXPIRED";

export type BookingPassenger = Readonly<{
  name: string;
  /**
   * A display copy of the passenger's seat ("12C"), written with the
   * booking. The truth about which seats a booking holds is
   * flight_seats.booking_id (Decision 10/11); this says who sits where. Null
   * only for a legacy booking cancelled before Day 48A.
   */
  seat: string | null;
  /**
   * The seat's fare class and that class's fare when the seats were held
   * (BR-BOOK-03, Decision 13) — never re-read from the flight, so a later
   * fare change does not reach this booking. Null exactly when `seat` is.
   */
  fareClass: FareClass | null;
  price: Money | null;
}>;

export type Booking = Readonly<{
  id: string;
  /** 6-character booking reference (BR-BOOK-05); unique. */
  reference: string;
  flightId: string;
  /** Identity account id (JWT `sub`). Not necessarily a passenger. */
  ownerAccountId: string;
  /** In request order: position 1 first. 1–9 (BR-BOOK-01). */
  passengers: readonly BookingPassenger[];
  /**
   * Derived, never stored: the sum of the passengers' prices (bookingTotal).
   * Those never change after the hold, so neither does this.
   */
  total: Money;
  createdAt: string;
  status: BookingStatus;
  /** Required while HELD; kept afterwards as history; null for legacy bookings. */
  holdExpiresAt: string | null;
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
 * What to hold (BR-BOOK-09: one kind per request, never a mix):
 * - auto: the `count` lowest AVAILABLE seats, row then letter.
 * - chosen: exactly these seats, distinct (the caller validated BR-BOOK-02).
 */
export type SeatHoldRequest =
  | Readonly<{ kind: "auto"; count: number }>
  | Readonly<{ kind: "chosen"; seats: readonly SeatPosition[] }>;

/**
 * A seat the hold took, with the price it was taken at: its fare class's
 * fare, read in the same statement that held it (Decision 13).
 */
export type HeldSeat = Readonly<{
  seat: string;
  fareClass: FareClass;
  price: Money;
}>;

/**
 * All or nothing (BR-SEAT-02): every outcome but `held` wrote nothing.
 * - held: one seat per passenger — `auto` in (row, letter) order,
 *   `chosen` in the request's order — each with its price.
 * - not-enough-seats (auto): fewer AVAILABLE seats than requested that this
 *   caller could take.
 * - seats-unavailable (chosen): these requested seats are held or booked;
 *   never says by whom.
 * - unknown-seats (chosen): these positions do not exist on this flight.
 * - sales-closed: the flight is not effectively OPEN at `now` (BR-FLT-06).
 */
export type HoldSeatsResult =
  | { outcome: "held"; seats: HeldSeat[] }
  | { outcome: "not-enough-seats" }
  | { outcome: "seats-unavailable"; seats: string[] }
  | { outcome: "unknown-seats"; seats: string[] }
  | { outcome: "sales-closed" }
  | { outcome: "flight-not-found" };

/**
 * - reference-taken: another booking already has `booking.reference`.
 *   Nothing was written and the surrounding transaction is still usable, so
 *   the caller can draw a new reference and try again.
 */
export type CreateBookingRepositoryResult =
  | { outcome: "created" }
  | { outcome: "reference-taken" };

/** A HELD booking that expireDueHolds moved to EXPIRED, with the seats it released. */
export type ExpiredHold = Readonly<{
  bookingId: string;
  reference: string;
  flightId: string;
  ownerAccountId: string;
  /** The deadline that passed (ISO), not the time of the sweep. */
  holdExpiresAt: string;
  /** Seat codes the booking held, (row, letter) order; now AVAILABLE. */
  seats: readonly string[];
}>;

/**
 * - expired: the booking is EXPIRED, or still HELD with a lapsed hold
 *   (BR-BOOK-10). Nothing was written: the expiry job ends it (Decision 12).
 */
export type CancelBookingRepositoryResult =
  | { outcome: "cancelled"; flightId: string }
  | { outcome: "already-cancelled" }
  | { outcome: "expired" }
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
   * Hold every requested seat of the flight for `bookingId` (status HELD), or
   * none (BR-SEAT-02), and only while the flight is bookable at `now`: stored
   * OPEN and more than 1 hour before departure (BR-FLT-06, the same rule as
   * isBookable). `now` comes from the caller so reads and holds use one
   * clock (ADR-008).
   *
   * Concurrency: `auto` skips seats another caller is taking right now;
   * `chosen` waits for them — the customer asked for those seats — and
   * therefore locks them in one global order, (row, letter), whatever order
   * the request lists them in, so two overlapping requests cannot deadlock.
   *
   * Called before create(booking): the booking id is generated first and
   * the seats point at it; the storage must accept that order within one
   * transaction (Decision 10).
   *
   * Prices (BR-BOOK-03): each held seat's fare is read by the same statement
   * that holds it, with the flight's fares share-locked, so a concurrent
   * fare change either waits for this hold or is seen whole by it — never
   * one class old and one new. A held seat whose class has no fare breaks
   * BR-FLT-09 and throws: it must not pass as free or as `not-enough-seats`.
   */
  holdSeats(
    flightId: string,
    bookingId: string,
    request: SeatHoldRequest,
    now: Date,
  ): Promise<HoldSeatsResult>;
  /**
   * Store the booking and its passengers with their prices, atomically
   * (`total` is not stored: reads derive it). A taken reference is
   * an expected outcome, not an error: it must leave the transaction usable
   * (on Postgres a failed statement would abort it, together with the seats
   * already claimed in it).
   */
  create(booking: Booking): Promise<CreateBookingRepositoryResult>;
  findById(
    bookingId: string,
    scope: BookingAccessScope,
  ): Promise<Booking | undefined>;
  /** Same scope rule as findById: another account's reference → undefined. */
  findByReference(
    reference: string,
    scope: BookingAccessScope,
  ): Promise<Booking | undefined>;
  /** Newest first (createdAt DESC, then id DESC as a stable tie-breaker). */
  findPage(
    scope: BookingAccessScope,
    request: BookingPageRequest,
  ): Promise<BookingPage>;
  /**
   * CONFIRMED, or HELD with a hold still valid at `now` (`holdExpiresAt >
   * now`, BR-BOOK-10) → CANCELLED, only inside the scope (OCC), and release
   * every seat of the booking (AVAILABLE, no booking) in the same statement —
   * so only the call that wins the transition releases them. The deadline is
   * checked in the statement itself, never by trusting that the expiry job
   * has run.
   *
   * CANCELLED answers already-cancelled; EXPIRED or a lapsed HELD answers
   * expired. Seats are locked in (row, letter) order, like expireDueHolds.
   */
  cancel(
    bookingId: string,
    scope: BookingAccessScope,
    now: Date,
  ): Promise<CancelBookingRepositoryResult>;
  /**
   * The expiry job's batch (Decision 12): up to `limit` HELD bookings whose
   * hold has lapsed at `now` — `holdExpiresAt <= now` (BR-BOOK-10), oldest
   * deadline first, then id — become EXPIRED, and every seat they held is
   * released, all in one statement. Returned in that order; an empty array
   * means nothing was due.
   *
   * No scope: the system acts on every account's bookings.
   *
   * Concurrency: a booking another transaction has locked right now (a
   * cancel, a second sweeper) is skipped, not waited for — the next run
   * picks it up if it is still due. Released seats are locked in (row,
   * letter) order, the order a chosen-seat hold locks them in, so a sweep
   * and a hold on the same seats cannot deadlock.
   *
   * Callers pair each result with an audit entry and an event; they run it
   * inside a transaction so a batch commits with them or not at all.
   */
  expireDueHolds(now: Date, limit: number): Promise<ExpiredHold[]>;
}>;
