import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import {
  AuditRecordOutsideTransactionError,
  createPostgresAuditRecorder,
} from "../../src/audit/postgres/postgres-audit-recorder.js";
import type { AuditRecordInput } from "../../src/audit/audit-recorder.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";

let dataSource: DataSource;

function makeInput(overrides: Partial<AuditRecordInput> = {}): AuditRecordInput {
  return {
    id: crypto.randomUUID(),
    action: "FLIGHT_CREATED",
    actor: { type: "admin_api_key", id: "admin" },
    target: { type: "flight", id: "flight-1" },
    requestId: "request-1",
    occurredAt: "2026-07-20T00:00:00.000Z",
    metadata: { flightNumber: "VN123" },
    ...overrides,
  };
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "audit_logs"');
});

after(async () => {
  await dataSource.destroy();
});

test("record() inside a transaction inserts a row with metadata as an object", async () => {
  const recorder = createPostgresAuditRecorder(dataSource);
  const runner = createPostgresTransactionRunner(dataSource);
  const input = makeInput();

  await runner.run(() => recorder.record(input));

  const rows = (await dataSource.query(
    `SELECT id, action, actor_type, actor_id, target_type, target_id,
            request_id, metadata
     FROM audit_logs WHERE id = $1`,
    [input.id],
  )) as Array<Record<string, unknown>>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["action"], "FLIGHT_CREATED");
  assert.equal(rows[0]?.["actor_type"], "admin_api_key");
  assert.equal(rows[0]?.["target_id"], "flight-1");
  assert.equal(typeof rows[0]?.["metadata"], "object");
  assert.deepEqual(rows[0]?.["metadata"], { flightNumber: "VN123" });
});

test("record() outside a transaction throws AuditRecordOutsideTransactionError", async () => {
  const recorder = createPostgresAuditRecorder(dataSource);

  await assert.rejects(
    () => recorder.record(makeInput()),
    AuditRecordOutsideTransactionError,
  );

  const rows = await dataSource.query(`SELECT id FROM audit_logs`);
  assert.equal(rows.length, 0);
});
