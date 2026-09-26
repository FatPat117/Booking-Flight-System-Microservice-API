import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Hand-written (reviewed SQL, not TypeORM's auto-generated diff) — mirrors
 * the constraints in api/src/migrations/migrations.ts (003_create_outbox),
 * translated to Postgres:
 * - TEXT payload -> jsonb (see OutboxEntity's doc comment for why)
 * - TEXT created_at/published_at -> TIMESTAMPTZ (same Section 2.4 reasoning
 *   already applied to flights' departure_at/arrival_at)
 * - SQLite STRICT -> nothing needed, Postgres columns are always typed
 * - Partial index (WHERE published_at IS NULL) is valid Postgres DDL as-is
 *   (Section 2.6) — this is the index OutboxRepository.findUnpublished
 *   depends on for the relay's poll query.
 */
export class CreateOutbox1790428672000 implements MigrationInterface {
  name = "CreateOutbox1790428672000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outbox" (
        "id" uuid NOT NULL,
        "event_type" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL,
        "published_at" TIMESTAMPTZ,
        CONSTRAINT "PK_outbox" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_outbox_event_type_length"
          CHECK (length("event_type") > 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_unpublished"
      ON "outbox" ("published_at")
      WHERE "published_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox"`);
  }
}
