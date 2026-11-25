import { after, before, beforeEach } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresAdminReports } from "../../src/reports/postgres/postgres-admin-reports.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { runAdminReportsContract } from "../contracts/admin-reports.contract.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * The same contract the in-memory fake runs in the unit tier
 * (tests/admin-reports.contract.test.ts), here against real Postgres.
 */

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

runAdminReportsContract("postgres", async () => {
  const transactionRunner = createPostgresTransactionRunner(dataSource);
  const auditRecorder = createPostgresAuditRecorder(dataSource);

  return {
    reports: createPostgresAdminReports(dataSource),
    flights: createPostgresFlightRepository(dataSource),
    bookings: createPostgresBookingRepository(dataSource),
    transaction: (work) => transactionRunner.run(work),
    record: (entry) => transactionRunner.run(() => auditRecorder.record(entry)),
  };
});
