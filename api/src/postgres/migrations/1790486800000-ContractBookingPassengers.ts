import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 48A (4 of 5) — contract. Drops `bookings.passenger_name`: passengers
 * live in `booking_passengers` from here.
 *
 * Reconciliation first, the last moment the old shape can be compared with
 * the new one. Refuses — never deletes, never "fixes" — listing each problem
 * (the Day 44/46/47 convention):
 *
 * 1. A CONFIRMED booking whose BOOKED seats differ from its passengers: count
 *    of seats ≠ count of passengers, or a passenger's seat copy is not one of
 *    the booking's seats.
 * 2. A CANCELLED booking that still holds a seat (it should have been
 *    released by its cancel).
 *
 * Which side is right is a human decision. Migrations run one transaction
 * each, so a refusal leaves the passengers table for a manual fix; then run
 * migrations again.
 */
export class ContractBookingPassengers1790486800000 implements MigrationInterface {
  name = "ContractBookingPassengers1790486800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        problems text;
      BEGIN
        SELECT string_agg(line, E'\\n' ORDER BY line)
        INTO problems
        FROM (
          SELECT format('  booking %s (%s) CONFIRMED on %s: %s BOOKED seat(s), %s passenger(s), %s matching',
                        b.reference, b.id, f.flight_number,
                        coalesce(seats.count, 0), coalesce(passengers.count, 0),
                        coalesce(matching.count, 0)) AS line
          FROM bookings b
          JOIN flights f ON f.id = b.flight_id
          LEFT JOIN (
            SELECT booking_id, count(*) AS count FROM flight_seats
            WHERE status = 'BOOKED' GROUP BY booking_id
          ) seats ON seats.booking_id = b.id
          LEFT JOIN (
            SELECT booking_id, count(*) AS count FROM booking_passengers GROUP BY booking_id
          ) passengers ON passengers.booking_id = b.id
          LEFT JOIN (
            SELECT p.booking_id, count(*) AS count
            FROM booking_passengers p
            JOIN bookings pb ON pb.id = p.booking_id
            JOIN flight_seats fs ON fs.booking_id = p.booking_id AND fs.flight_id = pb.flight_id
              AND fs.row = p.seat_row AND fs.letter = p.seat_letter AND fs.status = 'BOOKED'
            GROUP BY p.booking_id
          ) matching ON matching.booking_id = b.id
          WHERE b.status = 'CONFIRMED'
            AND NOT (coalesce(seats.count, 0) = coalesce(passengers.count, 0)
                 AND coalesce(passengers.count, 0) = coalesce(matching.count, 0)
                 AND coalesce(passengers.count, 0) > 0)
          UNION ALL
          SELECT format('  booking %s (%s) CANCELLED on %s still holds seat %s%s',
                        b.reference, b.id, f.flight_number, fs.row, fs.letter)
          FROM bookings b
          JOIN flights f ON f.id = b.flight_id
          JOIN flight_seats fs ON fs.booking_id = b.id
          WHERE b.status = 'CANCELLED'
        ) AS mismatches;

        IF problems IS NOT NULL THEN
          RAISE EXCEPTION E'Bookings, passengers and seats do not reconcile:\\n%', problems
            USING HINT = 'A CONFIRMED booking with no seat: cancel it (UPDATE bookings SET status = ''CANCELLED'' '
              || 'WHERE id = ''<id>'') or give it a free seat and copy it onto its passenger. '
              || 'A CANCELLED booking holding a seat: release it (UPDATE flight_seats SET status = ''AVAILABLE'', '
              || 'booking_id = NULL WHERE booking_id = ''<id>''). Then run migrations again.';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
        DROP CONSTRAINT "CHK_bookings_passenger_name_length",
        DROP COLUMN "passenger_name"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" ADD COLUMN "passenger_name" varchar
    `);

    // Lossy for multi-passenger bookings: only the first passenger fits.
    await queryRunner.query(`
      UPDATE "bookings" b SET "passenger_name" = p."name"
      FROM "booking_passengers" p
      WHERE p."booking_id" = b."id" AND p."position" = 1
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
        ALTER COLUMN "passenger_name" SET NOT NULL,
        ADD CONSTRAINT "CHK_bookings_passenger_name_length"
          CHECK (length("passenger_name") > 0)
    `);
  }
}
