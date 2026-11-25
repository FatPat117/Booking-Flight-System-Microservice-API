import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 53 (Decision 18, Day 52 review). The cascade's claim joined the
 * bookings of every CANCELLED flight on every run, and cancelled flights
 * only accumulate. `cascade_completed_at` marks a cancelled flight whose
 * cascade is done, so the claim reads only the flights still being worked
 * on, through a partial index that holds just those.
 *
 * - Written by the cascade job alone, when a flight has no live booking
 *   left (BookingRepository.completeFlightCancellations explains why that is
 *   final).
 * - `CHK_flights_cascade_completed_status`: only a CANCELLED flight can be
 *   complete (cancelling is final, Decision 11, so the mark never has to be
 *   undone).
 * - Backfill: every flight cancelled before today with no live booking left,
 *   at the migration's own clock — the same rule the job applies.
 */
export class AddFlightCascadeCompletedAt1790530000000 implements MigrationInterface {
  name = "AddFlightCascadeCompletedAt1790530000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "flights"
        ADD COLUMN "cascade_completed_at" timestamptz NULL,
        ADD CONSTRAINT "CHK_flights_cascade_completed_status"
          CHECK ("cascade_completed_at" IS NULL OR "status" = 'CANCELLED')
    `);
    await queryRunner.query(`
      UPDATE "flights" flight SET "cascade_completed_at" = now()
      WHERE flight."status" = 'CANCELLED'
        AND NOT EXISTS (
          SELECT 1 FROM "bookings" booking
          WHERE booking."flight_id" = flight."id"
            AND (booking."status" = 'CONFIRMED'
                 OR (booking."status" = 'HELD' AND booking."hold_expires_at" > now())))
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_flights_cascade_pending" ON "flights" ("id")
      WHERE "status" = 'CANCELLED' AND "cascade_completed_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_flights_cascade_pending"`);
    await queryRunner.query(`
      ALTER TABLE "flights"
        DROP CONSTRAINT "CHK_flights_cascade_completed_status",
        DROP COLUMN "cascade_completed_at"
    `);
  }
}
