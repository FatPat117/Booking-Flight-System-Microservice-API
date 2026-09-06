import type { DatabaseSync } from "node:sqlite";

import type {
  Booking,
  BookingRepository,
  CancelBookingRepositoryResult,
  ReserveSeatResult,
} from "./booking-repository.js";

type BookingLookupRow = {
  flight_id: string;
  status: string;
};

function readChangeCount(changes: number | bigint | undefined): number {
  if (changes === undefined) {
    return 0;
  }

  return typeof changes === "bigint" ? Number(changes) : changes;
}

export function createSqliteBookingRepository(
  database: DatabaseSync,
): BookingRepository {
  const decrementSeat = database.prepare(`
    UPDATE flights
    SET available_seats = available_seats - 1
    WHERE id = ? AND available_seats > 0
  `);

  const incrementSeat = database.prepare(`
    UPDATE flights
    SET available_seats = available_seats + 1
    WHERE id = ?
  `);

  const countFlightById = database.prepare(`
    SELECT COUNT(*) AS count
    FROM flights
    WHERE id = ?
  `);

  const insertBooking = database.prepare(`
    INSERT INTO bookings (id, flight_id, passenger_name, created_at, status)
    VALUES (?, ?, ?, ?, ?)
  `);

  const cancelActiveBooking = database.prepare(`
    UPDATE bookings
    SET status = 'cancelled'
    WHERE id = ? AND status = 'active'
  `);

  const selectBookingById = database.prepare(`
    SELECT flight_id, status
    FROM bookings
    WHERE id = ?
  `);

  return {
    reserveSeat(flightId): ReserveSeatResult {
      const result = decrementSeat.run(flightId);

      if (readChangeCount(result.changes) === 1) {
        return { outcome: "reserved" };
      }

      const row = countFlightById.get(flightId) as { count: number | bigint };
      const flightCount =
        typeof row.count === "bigint" ? Number(row.count) : row.count;

      if (flightCount === 0) {
        return { outcome: "flight-not-found" };
      }

      return { outcome: "sold-out" };
    },

    create(booking) {
      insertBooking.run(
        booking.id,
        booking.flightId,
        booking.passengerName,
        booking.createdAt,
        booking.status,
      );
    },

    cancel(bookingId): CancelBookingRepositoryResult {
      const result = cancelActiveBooking.run(bookingId);

      if (readChangeCount(result.changes) === 1) {
        const row = selectBookingById.get(bookingId) as
          | BookingLookupRow
          | undefined;

        if (row === undefined) {
          // Should not happen after a successful UPDATE — treat as not-found.
          return { outcome: "not-found" };
        }

        return { outcome: "cancelled", flightId: row.flight_id };
      }

      const row = selectBookingById.get(bookingId) as
        | BookingLookupRow
        | undefined;

      if (row === undefined) {
        return { outcome: "not-found" };
      }

      return { outcome: "already-cancelled" };
    },

    releaseSeat(flightId) {
      incrementSeat.run(flightId);
    },
  };
}
