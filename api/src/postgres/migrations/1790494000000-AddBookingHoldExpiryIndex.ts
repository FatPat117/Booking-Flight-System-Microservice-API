import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 48B. The expiry job's lookup (Decision 12): every 60 s it asks for the
 * oldest due holds,
 *
 *   WHERE status = 'HELD' AND hold_expires_at <= $1
 *   ORDER BY hold_expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
 *
 * - Partial on HELD: holds are a small, short-lived slice of `bookings`;
 *   CONFIRMED / CANCELLED / EXPIRED rows pile up for ever and are never due.
 *   The index stays the size of "holds open right now".
 * - `(hold_expires_at, id)` matches the ORDER BY exactly, so the plan reads
 *   the first due rows in order and stops at LIMIT — no Sort of every due
 *   hold. `id` makes the order total, so batches are deterministic.
 * - EXPIRED needs no constraint change: CHK_bookings_status has allowed it
 *   since MoveBookingsToLifecycle (Day 48A).
 * - Plain CREATE INDEX blocks writes to `bookings` while it builds. Fine on
 *   dev data; on a large live table this would be CREATE INDEX CONCURRENTLY,
 *   which cannot run inside the per-migration transaction
 *   (`migrationsTransactionMode: "each"`).
 */
export class AddBookingHoldExpiryIndex1790494000000 implements MigrationInterface {
  name = "AddBookingHoldExpiryIndex1790494000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "idx_bookings_held_expiry"
      ON "bookings" ("hold_expires_at", "id")
      WHERE "status" = 'HELD'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_bookings_held_expiry"`);
  }
}
