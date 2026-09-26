import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Hand-written (reviewed SQL, not TypeORM's auto-generated diff) — mirrors
 * the constraints in api/src/migrations/migrations.ts (002_create_audit_logs),
 * translated to Postgres:
 * - TEXT metadata_json -> jsonb "metadata" (see AuditEntity's doc comment)
 * - TEXT occurred_at -> TIMESTAMPTZ (same reasoning already applied to
 *   flights/outbox)
 * - SQLite STRICT -> nothing needed, Postgres columns are always typed
 *
 * CHECK constraints deliberately stay "loose" (length > 0 only) rather than
 * listing concrete action/actor_type values: this table is an append-only
 * log whose action/actor_type set grows with every new feature (each new
 * action would otherwise need its own migration just to widen a CHECK).
 * AuditAction/AuditActor/AuditTarget (audit-recorder.ts) are the real
 * guardrail, enforced by TypeScript at the call site.
 *
 * No indexes beyond the primary key: unlike SQLite's audit_logs (which
 * carries idx_audit_logs_occurred_at/target/request_id from an earlier day),
 * nothing in this codebase currently reads audit_logs — there is no
 * AuditRecorder query method, only record(). Adding indexes with no query to
 * serve is exactly the anti-pattern this day's lesson calls out; add one
 * later, with the query that needs it, not speculatively now.
 */
export class CreateAuditLogs1790432350000 implements MigrationInterface {
  name = "CreateAuditLogs1790432350000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" uuid NOT NULL,
        "action" character varying NOT NULL,
        "actor_type" character varying NOT NULL,
        "actor_id" character varying NOT NULL,
        "target_type" character varying NOT NULL,
        "target_id" character varying NOT NULL,
        "request_id" character varying,
        "occurred_at" TIMESTAMPTZ NOT NULL,
        "metadata" jsonb NOT NULL,
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_audit_logs_action_length"
          CHECK (length("action") > 0),
        CONSTRAINT "CHK_audit_logs_actor_type_length"
          CHECK (length("actor_type") > 0),
        CONSTRAINT "CHK_audit_logs_actor_id_length"
          CHECK (length("actor_id") > 0),
        CONSTRAINT "CHK_audit_logs_target_type_length"
          CHECK (length("target_type") > 0),
        CONSTRAINT "CHK_audit_logs_target_id_length"
          CHECK (length("target_id") > 0)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
  }
}
