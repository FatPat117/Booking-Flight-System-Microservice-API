import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Hand-written (reviewed SQL, not TypeORM's auto-generated diff) — mirrors
 * the constraints across api/src/migrations/migrations.ts
 * (004_create_bookings + 005_add_booking_status combined into one shape,
 * since this table is written fresh here, not retrofitted), translated to
 * Postgres:
 * - TEXT created_at -> TIMESTAMPTZ (same reasoning already applied to
 *   flights/outbox/audit_logs)
 * - status: CHECK (status IN ('active', 'cancelled')) — business data with a
 *   fixed value set (unlike audit_logs' deliberately loose CHECK), so a
 *   strict list is the right call here, same as SQLite's 005 migration.
 * - flight_id: REFERENCES flights(id), no ON DELETE clause (defaults to
 *   NO ACTION) — there is no delete-flight feature yet; NO ACTION blocks a
 *   future delete outright instead of silently cascading away booking
 *   history, matching this project's "least destructive default until the
 *   real need is known" principle (see Day 34's default role choice).
 *   Unlike SQLite (Day 35: `PRAGMA foreign_keys` was never enabled, so this
 *   FK was never actually enforced), Postgres enforces this FK for real —
 *   a genuine behavior change, exercised by a dedicated test.
 * - idx_bookings_flight_id: Postgres does not auto-create an index for FK
 *   columns (unlike the primary key) — needed for the same reason Day 26
 *   added it on SQLite: querying/joining by flight_id is a real, existing
 *   access pattern (releaseSeat/reserveSeat's flight lookups, and any
 *   future "bookings for this flight" read).
 */
export class CreateBookings1790436000000 implements MigrationInterface {
  name = "CreateBookings1790436000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "bookings" (
        "id" uuid NOT NULL,
        "flight_id" uuid NOT NULL,
        "passenger_name" character varying NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL,
        "status" character varying NOT NULL,
        CONSTRAINT "PK_bookings" PRIMARY KEY ("id"),
        CONSTRAINT "FK_bookings_flight_id" FOREIGN KEY ("flight_id")
          REFERENCES "flights" ("id"),
        CONSTRAINT "CHK_bookings_passenger_name_length"
          CHECK (length("passenger_name") > 0),
        CONSTRAINT "CHK_bookings_status"
          CHECK ("status" IN ('active', 'cancelled'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bookings_flight_id"
      ON "bookings" ("flight_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "bookings"`);
  }
}
