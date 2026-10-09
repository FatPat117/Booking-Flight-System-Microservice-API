import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 44, contract step of expand → contract (after AddBookingOwner).
 *
 * Bookings written before Day 44 have no owner, and there is no correct
 * owner to backfill them with. This migration does NOT delete them: a
 * migration that silently destroys data is the habit that loses production
 * data later. Instead it refuses to run while any ownerless row exists, with
 * a message saying what to do. For dev data (disposable since Day 35) the
 * answer is to reset booking_db; for a real system it would be a backfill
 * decided by a human (e.g. a "legacy" owner), shipped before this step.
 *
 * Failing here is the intended outcome on stale data, not a bug. TypeORM runs
 * pending migrations in one transaction, so the failure also rolls back the
 * expand step — the schema is left exactly as it was.
 */
export class RequireBookingOwner1790443600000 implements MigrationInterface {
  name = "RequireBookingOwner1790443600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        ownerless_count bigint;
      BEGIN
        SELECT count(*) INTO ownerless_count
        FROM "bookings"
        WHERE "owner_account_id" IS NULL;

        IF ownerless_count > 0 THEN
          RAISE EXCEPTION
            '% booking(s) have no owner_account_id. Backfill them or reset booking_db (dev data) before running this migration (Day 44).',
            ownerless_count;
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ALTER COLUMN "owner_account_id" SET NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ALTER COLUMN "owner_account_id" DROP NOT NULL
    `);
  }
}
