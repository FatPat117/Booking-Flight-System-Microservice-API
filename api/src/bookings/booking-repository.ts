export type Booking = Readonly<{
  id: string;
  flightId: string;
  passengerName: string;
  createdAt: string;
}>;

export type ReserveSeatResult =
  | { outcome: "reserved" }
  | { outcome: "sold-out" }
  | { outcome: "flight-not-found" };

export type BookingRepository = Readonly<{
  /**
   * Decrement availableSeats atomically — no separate read-then-write.
   */
  reserveSeat(flightId: string): ReserveSeatResult;
  create(booking: Booking): void;
}>;
