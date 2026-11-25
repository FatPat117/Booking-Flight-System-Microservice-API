import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 53 (Decision 19). The indexes the admin reports read through, shaped
 * by their queries — the Day 38 decision coming due: audit_logs had no index
 * because nothing read it (CreateAuditLogs), and now the audit log query
 * does.
 *
 * - `idx_audit_logs_target_occurred`: one target's entries, newest first
 *   (`target_type = $ AND target_id = $ ORDER BY occurred_at DESC, id DESC`),
 *   the keyset `(occurred_at, id) < (…)` continuing inside it.
 * - `idx_audit_logs_occurred`: a time range, newest first. Actor and action
 *   get no index: they only narrow what one of these two finds.
 * - `idx_flights_departure`: the load factor's widened UTC window over every
 *   route (idx_flights_route_departure starts with the origin, so it cannot
 *   serve "all routes"), with `id` for its keyset.
 *
 * CONCURRENTLY, so building them never blocks the writes every request
 * makes to audit_logs, the table that only grows. That cannot run inside a
 * transaction, hence `transaction = false`; if it fails halfway, Postgres
 * keeps an INVALID index of that name: drop it and run again.
 */
export class AddReportIndexes1790533600000 implements MigrationInterface {
  name = "AddReportIndexes1790533600000";
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY "idx_audit_logs_target_occurred"
        ON "audit_logs" ("target_type", "target_id", "occurred_at" DESC, "id" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY "idx_audit_logs_occurred"
        ON "audit_logs" ("occurred_at" DESC, "id" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY "idx_flights_departure"
        ON "flights" ("departure_at", "id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY "idx_flights_departure"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY "idx_audit_logs_occurred"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY "idx_audit_logs_target_occurred"`);
  }
}
