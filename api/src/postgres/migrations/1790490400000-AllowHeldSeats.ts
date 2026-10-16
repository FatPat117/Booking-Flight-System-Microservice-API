import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 48A (5 of 5). Seats can be HELD, and one booking can occupy several
 * (Decision 11).
 *
 * - CHK_flight_seats_status gains HELD. CHK_flight_seats_booking is unchanged:
 *   `(status = 'AVAILABLE') = (booking_id IS NULL)` already requires a booking
 *   for a HELD seat.
 * - UQ_flight_seats_booking_id ("one booking, one seat", Decision 10) is
 *   dropped on purpose: a booking holds 1–9 seats now. A passenger still has
 *   one seat — UQ_booking_passengers_seat on the Booking side.
 * - idx_flight_seats_booking_id replaces the index the unique constraint gave
 *   for free: cancel (and the 48B expiry job) release a booking's seats by
 *   `WHERE booking_id = $1`. Partial: AVAILABLE seats have no booking.
 */
export class AllowHeldSeats1790490400000 implements MigrationInterface {
  name = "AllowHeldSeats1790490400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "flight_seats"
        DROP CONSTRAINT "CHK_flight_seats_status",
        ADD CONSTRAINT "CHK_flight_seats_status"
          CHECK ("status" IN ('AVAILABLE', 'HELD', 'BOOKED')),
        DROP CONSTRAINT "UQ_flight_seats_booking_id"
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_flight_seats_booking_id"
      ON "flight_seats" ("booking_id")
      WHERE "booking_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM flight_seats WHERE status = 'HELD')
           OR EXISTS (SELECT 1 FROM flight_seats WHERE booking_id IS NOT NULL
                      GROUP BY booking_id HAVING count(*) > 1) THEN
          RAISE EXCEPTION 'HELD seats or bookings with several seats exist'
            USING HINT = 'Release them first, then revert again.';
        END IF;
      END $$;
    `);

    await queryRunner.query(`DROP INDEX "idx_flight_seats_booking_id"`);

    await queryRunner.query(`
      ALTER TABLE "flight_seats"
        ADD CONSTRAINT "UQ_flight_seats_booking_id" UNIQUE ("booking_id"),
        DROP CONSTRAINT "CHK_flight_seats_status",
        ADD CONSTRAINT "CHK_flight_seats_status"
          CHECK ("status" IN ('AVAILABLE', 'BOOKED'))
    `);
  }
}
