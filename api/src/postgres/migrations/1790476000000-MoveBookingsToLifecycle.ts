import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 48A (1 of 5). Bookings move to the lifecycle of domain-model "Lifecycles
 * → Booking": HELD / CONFIRMED / CANCELLED / EXPIRED (Decision 11).
 *
 * - Legacy `active` → `CONFIRMED`, `cancelled` → `CANCELLED`. A legacy booking
 *   kept its seat for good (no hold, no payment), so it was confirmed in all
 *   but name; as HELD, the 48B expiry job would release it 15 minutes later.
 * - No intermediate "old + new values" CHECK: the drop, the UPDATE and the new
 *   CHECK run in one transaction, so no other writer ever sees a mixed table.
 *   A zero-downtime deploy (old code still writing `active`) would need that
 *   wide CHECK as its own step, released before the code switch.
 * - hold_expires_at: required while HELD (CHK_bookings_hold_expiry), kept
 *   afterwards as history — an EXPIRED or CONFIRMED booking still had a
 *   deadline. Legacy CONFIRMED bookings never had one: NULL.
 */
export class MoveBookingsToLifecycle1790476000000 implements MigrationInterface {
  name = "MoveBookingsToLifecycle1790476000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP CONSTRAINT "CHK_bookings_status"
    `);

    await queryRunner.query(`
      UPDATE "bookings"
      SET "status" = CASE "status" WHEN 'active' THEN 'CONFIRMED' ELSE 'CANCELLED' END
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
        ADD CONSTRAINT "CHK_bookings_status"
          CHECK ("status" IN ('HELD', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
        ADD COLUMN "hold_expires_at" timestamptz,
        ADD CONSTRAINT "CHK_bookings_hold_expiry"
          CHECK ("status" <> 'HELD' OR "hold_expires_at" IS NOT NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // HELD and EXPIRED have no legacy equivalent; refuse rather than guess.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM bookings WHERE status IN ('HELD', 'EXPIRED')) THEN
          RAISE EXCEPTION 'HELD or EXPIRED bookings exist; they have no active/cancelled equivalent'
            USING HINT = 'Cancel or delete them first, then revert again.';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
        DROP CONSTRAINT "CHK_bookings_hold_expiry",
        DROP COLUMN "hold_expires_at",
        DROP CONSTRAINT "CHK_bookings_status"
    `);

    await queryRunner.query(`
      UPDATE "bookings"
      SET "status" = CASE "status" WHEN 'CONFIRMED' THEN 'active' ELSE 'cancelled' END
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
        ADD CONSTRAINT "CHK_bookings_status" CHECK ("status" IN ('active', 'cancelled'))
    `);
  }
}
