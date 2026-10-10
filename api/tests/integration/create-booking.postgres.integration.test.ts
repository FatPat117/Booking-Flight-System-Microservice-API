import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createCreateBooking } from "../../src/bookings/create-booking.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { Flight } from "../../src/types.js";
import { makeFlight as makeFixtureFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * Runs the real createCreateBooking use case wired to every Postgres
 * adapter (Flight + Booking + Audit + Outbox + TransactionRunner) — the
 * Day 38 create-flight.postgres.integration.test.ts pattern, applied to the
 * one use case that also contends for a shared row (available_seats).
 */

const OWNER_ACTOR = { accountId: "11111111-1111-4111-8111-111111111111" };

let dataSource: DataSource;

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return makeFixtureFlight({ availableSeats: 1, ...overrides });
}

function createUseCase() {
  return createCreateBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
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
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

test("created: writes one booking row, decrements the seat, one audit row, one outbox row", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);

  const createBooking = createUseCase();
  const result = await createBooking(flight.id, { passengerName: "Alice" }, OWNER_ACTOR);

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }

  const bookingRows = (await dataSource.query(
    `SELECT id, flight_id, owner_account_id, status FROM bookings`,
  )) as Array<{
    id: string;
    flight_id: string;
    owner_account_id: string;
    status: string;
  }>;
  const auditRows = await dataSource.query(`SELECT id, target_id FROM audit_logs`);
  const outboxRows = (await dataSource.query(
    `SELECT id, event_type FROM outbox`,
  )) as Array<{ id: string; event_type: string }>;

  assert.equal(bookingRows.length, 1);
  assert.equal(bookingRows[0]?.id, result.booking.id);
  assert.equal(bookingRows[0]?.flight_id, flight.id);
  assert.equal(bookingRows[0]?.owner_account_id, OWNER_ACTOR.accountId);
  assert.equal(bookingRows[0]?.status, "active");

  assert.equal(auditRows.length, 1);
  assert.equal(outboxRows.length, 1);
  assert.equal(outboxRows[0]?.event_type, "booking-created");

  const afterFlight = await flightRepository.findById(flight.id);
  assert.equal(afterFlight?.availableSeats, 0);
});

test("sold-out: no booking, audit, or outbox row is written, and the seat count is unchanged", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ availableSeats: 0 });
  await flightRepository.create(flight);

  const createBooking = createUseCase();
  const result = await createBooking(flight.id, { passengerName: "Alice" }, OWNER_ACTOR);

  assert.equal(result.outcome, "sold-out");

  const bookingRows = await dataSource.query(`SELECT id FROM bookings`);
  const auditRows = await dataSource.query(`SELECT id FROM audit_logs`);
  const outboxRows = await dataSource.query(`SELECT id FROM outbox`);

  assert.equal(bookingRows.length, 0);
  assert.equal(auditRows.length, 0);
  assert.equal(outboxRows.length, 0);

  const afterFlight = await flightRepository.findById(flight.id);
  assert.equal(afterFlight?.availableSeats, 0);
});

test("flight-not-found: resolves flight-not-found for an unknown flight id", async () => {
  const createBooking = createUseCase();

  const result = await createBooking(
    crypto.randomUUID(),
    { passengerName: "Alice" },
    OWNER_ACTOR,
  );

  assert.equal(result.outcome, "flight-not-found");
});
