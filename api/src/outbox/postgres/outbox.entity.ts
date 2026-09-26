import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * Day 37 — dev-complete only (same caveat as FlightEntity's doc comment).
 * Mirrors SQLite's `outbox` table (api/src/migrations/migrations.ts,
 * 003_create_outbox) with two deliberate deltas — see this entity's sibling
 * migration for the full reasoning:
 * - payload: jsonb, not text — TypeORM's Postgres driver stringifies on
 *   write and node-postgres auto-parses jsonb back to a JS value on read,
 *   so postgres-outbox-repository.ts needs no manual JSON.stringify/parse,
 *   unlike sqlite-outbox-repository.ts.
 * - created_at/published_at: TIMESTAMPTZ, not text — same reasoning
 *   FlightEntity already applies for its own timestamps (real chronological
 *   comparison, not string-format discipline).
 *
 * @PrimaryColumn, not @PrimaryGeneratedColumn: create-flight.ts (and
 * create-booking.ts/cancel-booking.ts) already assign `id` via
 * generateOutboxId() before calling OutboxRepository.enqueue() — same reason
 * as FlightEntity.
 */
@Entity({ name: "outbox" })
export class OutboxEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "varchar", name: "event_type" })
  eventType!: string;

  // `any`, not `unknown`: TypeORM's QueryDeepPartialEntity mapped type can't
  // handle an `unknown`-typed column (breaks .insert()/.save() typing) — this
  // is the one place that ORM limitation is visible; OutboxEntry.payload
  // stays `unknown` at the domain boundary (mapOutbox in
  // postgres-outbox-repository.ts).
  @Column({ type: "jsonb" })
  payload: any;

  @Column({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;

  @Column({ type: "timestamptz", name: "published_at", nullable: true })
  publishedAt!: Date | null;
}
