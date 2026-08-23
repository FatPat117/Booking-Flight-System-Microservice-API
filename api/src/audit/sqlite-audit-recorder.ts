import type { DatabaseSync } from "node:sqlite";

import type { AuditRecordInput, AuditRecorder } from "./audit-recorder.js";

export function createSqliteAuditRecorder(
  database: DatabaseSync,
): AuditRecorder {
  const insertAuditLog = database.prepare(`
    INSERT INTO audit_logs (
      id,
      action,
      actor_type,
      actor_id,
      target_type,
      target_id,
      request_id,
      occurred_at,
      metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    record(input: AuditRecordInput): void {
      insertAuditLog.run(
        input.id,
        input.action,
        input.actor.type,
        input.actor.id,
        input.target.type,
        input.target.id,
        input.requestId ?? null,
        input.occurredAt,
        JSON.stringify(input.metadata),
      );
    },
  };
}
