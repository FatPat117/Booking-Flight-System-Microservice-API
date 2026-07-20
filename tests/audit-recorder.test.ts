import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteAuditRecorder } from "../src/audit/sqlite-audit-recorder.js";
import { openDatabase } from "../src/database.js";

test("records audit log in SQLite", (t) => {
  const database = openDatabase(":memory:");

  t.after(() => {
    database.close();
  });

  const auditRecorder = createSqliteAuditRecorder(database);

  auditRecorder.record({
    id: "audit-1",
    action: "FLIGHT_CREATED",
    actor: {
      type: "admin_api_key",
      id: "admin",
    },
    target: {
      type: "flight",
      id: "flight-1",
    },
    requestId: "request-1",
    occurredAt: "2026-07-20T00:00:00.000Z",
    metadata: {
      flightNumber: "VN123",
      origin: "SGN",
      destination: "HAN",
    },
  });

  const row = database
    .prepare(
      `
        SELECT
          id,
          action,
          actor_type,
          actor_id,
          target_type,
          target_id,
          request_id,
          occurred_at,
          metadata_json
        FROM audit_logs
        WHERE id = ?
        `,
    )
    .get("audit-1") as
    | {
        id: string;
        action: string;
        actor_type: string;
        actor_id: string;
        target_type: string;
        target_id: string;
        request_id: string | null;
        occurred_at: string;
        metadata_json: string;
      }
    | undefined;

  assert.ok(row);

  assert.equal(row.id, "audit-1");
  assert.equal(row.action, "FLIGHT_CREATED");
  assert.equal(row.actor_type, "admin_api_key");
  assert.equal(row.actor_id, "admin");
  assert.equal(row.target_type, "flight");
  assert.equal(row.target_id, "flight-1");
  assert.equal(row.request_id, "request-1");
  assert.equal(row.occurred_at, "2026-07-20T00:00:00.000Z");
  assert.deepEqual(JSON.parse(row.metadata_json), {
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
  });
});
