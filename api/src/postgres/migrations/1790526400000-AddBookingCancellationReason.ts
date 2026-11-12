import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 52 (Decision 18). Why a booking was cancelled is data, not a hidden
 * flag: `CUSTOMER` (the owner, BR-BOOK-06 applies) or `AIRLINE` (the flight
 * cancellation cascade, it does not, BR-FLT-07). The rule, what the
 * customer is told and the reports all differ by it.
 *
 * - Nullable, and set exactly when the booking is CANCELLED:
 *   `CHK_bookings_cancellation_reason_status` says so in both directions, so
 *   a live booking never carries a reason and a cancelled one never lacks
 *   one.
 * - Backfill: every booking cancelled before today was cancelled by its
 *   owner — no route let anyone else cancel (Day 44 permission matrix), and
 *   no flight could be cancelled until today. So `CUSTOMER`, with no
 *   booking that cannot be derived (unlike the fares backfill, Day 49A).
 * - One migration, not expand/backfill/contract: the column, its values and
 *   both CHECKs land together. An old api instance still running against
 *   the new schema would fail every cancel on the second CHECK (it does not
 *   write the column). Accepted: the api runs as one instance and runs its
 *   own migrations at startup (bootstrap/application.ts); a rolling deploy would need the
 *   CHECK in a later migration, after every instance writes the column.
 */
export class AddBookingCancellationReason1790526400000 implements MigrationInterface {
  name = "AddBookingCancellationReason1790526400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" ADD COLUMN "cancellation_reason" varchar NULL
    `);
    await queryRunner.query(`
      UPDATE "bookings" SET "cancellation_reason" = 'CUSTOMER'
      WHERE "status" = 'CANCELLED'
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
        ADD CONSTRAINT "CHK_bookings_cancellation_reason"
          CHECK ("cancellation_reason" IN ('CUSTOMER', 'AIRLINE')),
        ADD CONSTRAINT "CHK_bookings_cancellation_reason_status"
          CHECK (("status" = 'CANCELLED') = ("cancellation_reason" IS NOT NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
        DROP CONSTRAINT "CHK_bookings_cancellation_reason_status",
        DROP CONSTRAINT "CHK_bookings_cancellation_reason",
        DROP COLUMN "cancellation_reason"
    `);
  }
}
