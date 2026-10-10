import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createCancelBooking } from "../../src/bookings/cancel-booking.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { Flight } from "../../src/types.js";
import { makeFlight as makeFixtureFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * Runs the real createCancelBooking use case wired to every Postgres
 * adapter, same pattern as create-booking.postgres.integration.test.ts.
 */

const OWNER_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_SCOPE = { kind: "owner", accountId: OWNER_ACCOUNT_ID } as const;
const OWNER_ACTOR = { accountId: OWNER_ACCOUNT_ID };

let dataSource: DataSource;

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return makeFixtureFlight({ availableSeats: 1, ...overrides });
}

function createUseCase() {
  return createCancelBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
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

test("cancelled then already-cancelled: seat count increases by exactly 1, no extra audit/outbox rows on the second call", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);
  await bookingRepository.reserveSeat(flight.id, new Date("2026-07-20T00:00:00.000Z"));

  const booking = {
    id: crypto.randomUUID(),
    flightId: flight.id,
    ownerAccountId: OWNER_ACCOUNT_ID,
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active" as const,
  };
  await bookingRepository.create(booking);

  const cancelBooking = createUseCase();

  const first = await cancelBooking(booking.id, OWNER_SCOPE, OWNER_ACTOR);
  assert.deepEqual(first, {
    outcome: "cancelled",
    bookingId: booking.id,
    flightId: flight.id,
  });

  const afterFirst = await flightRepository.findById(flight.id);
  assert.equal(afterFirst?.availableSeats, 1);

  const second = await cancelBooking(booking.id, OWNER_SCOPE, OWNER_ACTOR);
  assert.equal(second.outcome, "already-cancelled");

  const afterSecond = await flightRepository.findById(flight.id);
  assert.equal(afterSecond?.availableSeats, 1);

  const auditRows = await dataSource.query(
    `SELECT id FROM audit_logs WHERE target_id = $1`,
    [booking.id],
  );
  const outboxRows = await dataSource.query(`SELECT id FROM outbox`);
  assert.equal(auditRows.length, 1);
  assert.equal(outboxRows.length, 1);
});

test("not-found: resolves not-found for an unknown booking id", async () => {
  const cancelBooking = createUseCase();

  const result = await cancelBooking(crypto.randomUUID(), OWNER_SCOPE, OWNER_ACTOR);
  assert.equal(result.outcome, "not-found");
});
