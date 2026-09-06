export type BookingStatus = "active" | "cancelled";

export type Booking = Readonly<{
  id: string;
  flightId: string;
  passengerName: string;
  createdAt: string;
  status: BookingStatus;
}>;

export type ReserveSeatResult =
  | { outcome: "reserved" }
  | { outcome: "sold-out" }
  | { outcome: "flight-not-found" };

export type CancelBookingRepositoryResult =
  | { outcome: "cancelled"; flightId: string }
  | { outcome: "already-cancelled" }
  | { outcome: "not-found" };

export type BookingRepository = Readonly<{
  /**
   * Decrement availableSeats atomically — no separate read-then-write.
   */
  reserveSeat(flightId: string): ReserveSeatResult;
  create(booking: Booking): void;
  /**
   * Mark booking cancelled only when still active (OCC).
   * Seat release stays in the use case — only after a successful first cancel.
   */
  cancel(bookingId: string): CancelBookingRepositoryResult;
  /**
   * Increment availableSeats by 1. Call only after cancel() returns cancelled.
   */
  releaseSeat(flightId: string): void;
}>;
