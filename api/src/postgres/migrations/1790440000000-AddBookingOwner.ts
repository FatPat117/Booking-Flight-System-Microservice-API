import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 44, expand step of expand → contract (RequireBookingOwner1790443600000
 * is the contract step). The column starts nullable so existing rows don't
 * block it; from this release on, every new booking is written with an owner.
 *
 * owner_account_id is the Identity account's id (JWT `sub`, a uuid in
 * identity_db.users). Deliberately NO foreign key: the accounts live in a
 * different database (identity_db), Postgres cannot reference across
 * databases, and that separation is the point of the Day 36/42 boundary —
 * api trusts the signed JWT, not a join. Consequence, accepted: deleting an
 * account in Identity does not touch its bookings here. If that ever matters
 * it becomes an event (account-deleted) consumed by api, not a constraint.
 *
 * idx_bookings_owner_created serves exactly one real query: "my bookings,
 * newest first" (findPage with an owner scope: WHERE owner_account_id = $1
 * ORDER BY created_at DESC, id DESC LIMIT/OFFSET). The leading column filters,
 * the next two match the sort, so Postgres reads the page straight from the
 * index without sorting. Contrast with CreateAuditLogs (Day 38): no query, no
 * index; here the query exists first and the index is shaped to it.
 */
export class AddBookingOwner1790440000000 implements MigrationInterface {
  name = "AddBookingOwner1790440000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "owner_account_id" uuid NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bookings_owner_created"
      ON "bookings" ("owner_account_id", "created_at" DESC, "id" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_bookings_owner_created"`);
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP COLUMN IF EXISTS "owner_account_id"`,
    );
  }
}
