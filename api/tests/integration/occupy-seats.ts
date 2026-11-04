import type { DataSource } from "typeorm";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import { nextBookingReference } from "../fixtures/bookings.js";

/**
 * Sells `codes` of a flight to one CONFIRMED booking, straight in SQL — a
 * fixture for read-side tests (flight search) that need seats taken without
 * going through hold and payment. Nothing here is a business rule.
 */
export async function occupySeats(
  dataSource: DataSource,
  flightId: string,
  codes: readonly string[],
): Promise<void> {
  if (codes.length === 0) return;
  const positions = codes.map((code) => {
    const position = parseSeatPosition(code);
    if (position === undefined) throw new Error(`bad seat code ${code}`);
    return position;
  });
  const bookingId = crypto.randomUUID();

  await dataSource.transaction(async (manager) => {
    await manager.query(
      `INSERT INTO "bookings" ("id", "flight_id", "created_at", "status", "owner_account_id", "hold_expires_at", "reference")
       VALUES ($1, $2, now(), 'CONFIRMED', '33333333-3333-4333-8333-333333333333', NULL, $3)`,
      [bookingId, flightId, nextBookingReference()],
    );
    const updated = (await manager.query(
      `UPDATE "flight_seats" SET "status" = 'BOOKED', "booking_id" = $2
       WHERE "flight_id" = $1 AND "status" = 'AVAILABLE'
         AND ("row", "letter"::text) IN (SELECT * FROM unnest($3::int[], $4::text[]))`,
      [flightId, bookingId, positions.map((p) => p.row), positions.map((p) => p.letter)],
    )) as [unknown, number];
    if (updated[1] !== codes.length) {
      throw new Error(`occupied ${updated[1]} of ${codes.length} seats on ${flightId}`);
    }
  });
}
