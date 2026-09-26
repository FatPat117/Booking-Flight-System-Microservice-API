import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * Day 38 — dev-complete only (same caveat as FlightEntity/OutboxEntity's doc
 * comments). Mirrors SQLite's `audit_logs` table
 * (api/src/migrations/migrations.ts, 002_create_audit_logs) with the same
 * two deltas already applied to Outbox — see this entity's sibling
 * migration for the full reasoning:
 * - metadata: jsonb, not text — no manual JSON.stringify/parse needed in
 *   postgres-audit-recorder.ts, unlike sqlite-audit-recorder.ts.
 * - occurred_at: TIMESTAMPTZ, not text.
 *
 * actor/target stay split into actor_type/actor_id/target_type/target_id
 * columns (not jsonb) — same shape as SQLite, and it keeps
 * `WHERE target_type = ? AND target_id = ?` a plain column query if a reader
 * is ever added.
 *
 * `metadata` intentionally does NOT reuse the `any` workaround from
 * OutboxEntity.payload — AuditMetadata is a concrete
 * `Record<string, string | number | boolean | null>`, not `unknown`, so
 * TypeORM's QueryDeepPartialEntity can type-check it directly.
 *
 * @PrimaryColumn, not @PrimaryGeneratedColumn: create-flight.ts,
 * create-booking.ts and cancel-booking.ts already assign `id` via
 * generateAuditId() before calling AuditRecorder.record() — same reason as
 * FlightEntity/OutboxEntity.
 */
@Entity({ name: "audit_logs" })
export class AuditEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  action!: string;

  @Column({ type: "varchar", name: "actor_type" })
  actorType!: string;

  @Column({ type: "varchar", name: "actor_id" })
  actorId!: string;

  @Column({ type: "varchar", name: "target_type" })
  targetType!: string;

  @Column({ type: "varchar", name: "target_id" })
  targetId!: string;

  @Column({ type: "varchar", name: "request_id", nullable: true })
  requestId!: string | null;

  @Column({ type: "timestamptz", name: "occurred_at" })
  occurredAt!: Date;

  @Column({ type: "jsonb" })
  metadata!: Record<string, string | number | boolean | null>;
}
