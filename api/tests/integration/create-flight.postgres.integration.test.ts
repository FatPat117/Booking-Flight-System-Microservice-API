import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../../src/audit/audit-recorder.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createCreateFlight } from "../../src/flights/create-flight.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";

/**
 * Runs the real createCreateFlight use case, wired end to end with every
 * Postgres adapter (Flight + Audit + Outbox + TransactionRunner) — not any
 * one adapter's own behavior (see the other tests in this directory). This
 * is a rehearsal for cutover at use-case scope: it exercises the exact call
 * sequence production runs (validate -> transactionRunner.run ->
 * flightRepository.create -> auditRecorder.record ->
 * outboxRepository.enqueue -> commit), so any SQLite/Postgres divergence in
 * that sequence surfaces here first.
 */

let dataSource: DataSource;

function makeRawInput(overrides: Record<string, unknown> = {}) {
  return {
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T08:00:00+07:00",
    arrivalAt: "2026-08-10T10:00:00+07:00",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 120,
    ...overrides,
  };
}

function createUseCase(
  auditRecorder: AuditRecorder = createPostgresAuditRecorder(dataSource),
) {
  return createCreateFlight({
    flightRepository: createPostgresFlightRepository(dataSource),
    auditRecorder,
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => "request-1",
    getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
  });
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "flights", "audit_logs", "outbox"');
});

after(async () => {
  await dataSource.destroy();
});

test("created: writes exactly one row each to flights, audit_logs, and outbox", async () => {
  const createFlight = createUseCase();

  const result = await createFlight(makeRawInput());

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }

  const flightRows = (await dataSource.query(`SELECT id FROM flights`)) as Array<{
    id: string;
  }>;
  const auditRows = (await dataSource.query(
    `SELECT id, target_id FROM audit_logs`,
  )) as Array<{ id: string; target_id: string }>;
  const outboxRows = (await dataSource.query(
    `SELECT id, payload FROM outbox`,
  )) as Array<{ id: string; payload: { eventId: string; correlationId: string } }>;

  assert.equal(flightRows.length, 1);
  assert.equal(auditRows.length, 1);
  assert.equal(outboxRows.length, 1);

  assert.equal(flightRows[0]?.id, result.flight.id);
  assert.equal(auditRows[0]?.target_id, result.flight.id);
  assert.ok(outboxRows[0]?.payload.eventId);
  assert.ok(outboxRows[0]?.payload.correlationId);
});

test("duplicate: second create with the same flightNumber+departureAt resolves duplicate, no extra audit/outbox rows", async () => {
  const createFlight = createUseCase();
  const input = makeRawInput();

  const first = await createFlight(input);
  assert.equal(first.outcome, "created");

  const second = await createFlight(input);
  assert.equal(second.outcome, "duplicate");

  const flightRows = await dataSource.query(`SELECT id FROM flights`);
  const auditRows = await dataSource.query(`SELECT id FROM audit_logs`);
  const outboxRows = await dataSource.query(`SELECT id FROM outbox`);

  assert.equal(flightRows.length, 1);
  assert.equal(auditRows.length, 1);
  assert.equal(outboxRows.length, 1);
});

test("mid-transaction failure: an error after the audit write rolls back flights, audit_logs, and outbox together", async () => {
  const realAuditRecorder = createPostgresAuditRecorder(dataSource);
  const throwingAuditRecorder: AuditRecorder = {
    async record(input: AuditRecordInput) {
      await realAuditRecorder.record(input);
      throw new Error("boom after audit write");
    },
  };

  const createFlight = createUseCase(throwingAuditRecorder);

  await assert.rejects(
    () => createFlight(makeRawInput()),
    /boom after audit write/,
  );

  const flightRows = await dataSource.query(`SELECT id FROM flights`);
  const auditRows = await dataSource.query(`SELECT id FROM audit_logs`);
  const outboxRows = await dataSource.query(`SELECT id FROM outbox`);

  assert.equal(flightRows.length, 0);
  assert.equal(auditRows.length, 0);
  assert.equal(outboxRows.length, 0);
});
