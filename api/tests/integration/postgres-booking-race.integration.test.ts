import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { DataSource } from "typeorm";

import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createCancelBooking } from "../../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../../src/bookings/create-booking.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { FlightEntity } from "../../src/flights/postgres/flight.entity.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { resolveEntityManager } from "../../src/postgres/transaction-context.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { Flight } from "../../src/types.js";

/**
 * The moment of truth for the whole BookingRepository migration: OCC
 * (ADR-004) proven under REAL concurrency — separate pg Pool connections
 * running actual parallel transactions, not SQLite's single connection +
 * promise queue (Day 36) that made races structurally impossible to
 * observe. Same race scenarios as Day 26 (overbooking) / Day 28
 * (double-cancel), re-run here against real Postgres.
 *
 * Pool size matters for what "real concurrency" means here: DataSource in
 * postgres/data-source.ts sets no `extra.max`, so node-postgres's default
 * Pool max (10) applies. 20 concurrent createBooking calls means at most
 * 10 run truly in parallel at any instant; the rest queue for a connection.
 * That's still genuine contention on the same flights row (the thing OCC
 * has to survive) — it just means "20 concurrent" here doesn't mean "20
 * simultaneous BEGINs."
 */

let dataSource: DataSource;

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: crypto.randomUUID(),
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T08:00:00+07:00",
    arrivalAt: "2026-08-10T10:00:00+07:00",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 1,
    ...overrides,
  };
}

function createCreateBookingUseCase() {
  return createCreateBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
  });
}

function createCancelBookingUseCase() {
  return createCancelBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
  });
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query(
    'TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE',
  );
});

after(async () => {
  await dataSource.destroy();
});

test("Test A — 20 concurrent createBooking calls on a 5-seat flight yield exactly 5 created and 15 sold-out", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ availableSeats: 5 });
  await flightRepository.create(flight);

  const createBooking = createCreateBookingUseCase();

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      createBooking(flight.id, { passengerName: `Passenger ${i}` }),
    ),
  );

  const created = results.filter((r) => r.outcome === "created");
  const soldOut = results.filter((r) => r.outcome === "sold-out");

  assert.equal(created.length, 5);
  assert.equal(soldOut.length, 15);

  const afterFlight = await flightRepository.findById(flight.id);
  assert.equal(afterFlight?.availableSeats, 0);

  const bookingRows = await dataSource.query(`SELECT id FROM bookings`);
  assert.equal(bookingRows.length, 5);
});

test("Test B — 10 concurrent cancelBooking calls on the same active booking yield exactly 1 cancelled and 9 already-cancelled, seat released once", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);
  await bookingRepository.reserveSeat(flight.id);

  const booking = {
    id: crypto.randomUUID(),
    flightId: flight.id,
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active" as const,
  };
  await bookingRepository.create(booking);

  const cancelBooking = createCancelBookingUseCase();

  const results = await Promise.all(
    Array.from({ length: 10 }, () => cancelBooking(booking.id)),
  );

  const cancelled = results.filter((r) => r.outcome === "cancelled");
  const alreadyCancelled = results.filter(
    (r) => r.outcome === "already-cancelled",
  );

  assert.equal(cancelled.length, 1);
  assert.equal(alreadyCancelled.length, 9);

  const afterFlight = await flightRepository.findById(flight.id);
  assert.equal(afterFlight?.availableSeats, 1);
});

/**
 * Test C — counter-proof. This naive implementation exists ONLY here, never
 * in src/: it is the exact anti-pattern ADR-004 rejects (SELECT the value,
 * decide in TypeScript, then UPDATE the computed value) — the bug this
 * whole day set out to prove is real on Postgres, not just theoretical.
 *
 * The artificial delay between SELECT and UPDATE isn't cheating the test —
 * it deliberately widens the check-then-act gap so the race reliably wins
 * instead of depending on how fast 20 local DB round-trips happen to land.
 * A version without the delay would still race, just less deterministically
 * (see the Pause & Think note in DAY-39.md for what a single non-racing run
 * would and wouldn't prove).
 */
async function reserveSeatNaive(
  flightId: string,
  delayMs: number,
): Promise<"reserved" | "sold-out"> {
  const manager = resolveEntityManager(dataSource);
  const repository = manager.getRepository(FlightEntity);

  const flight = await repository.findOneBy({ id: flightId });
  if (!flight || flight.availableSeats <= 0) {
    return "sold-out";
  }

  await sleep(delayMs);

  await repository.update(
    { id: flightId },
    { availableSeats: flight.availableSeats - 1 },
  );

  return "reserved";
}

test("Test C — counter-proof: naive SELECT-then-UPDATE overbooks a 5-seat flight under real concurrency", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ availableSeats: 5 });
  await flightRepository.create(flight);

  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () => reserveSeatNaive(flight.id, 30)),
  );

  const reservedCount = outcomes.filter((o) => o === "reserved").length;

  const afterFlight = await flightRepository.findById(flight.id);

  // With only 5 real seats, a correct implementation can never let more
  // than 5 callers win. The naive implementation lets all 20 "win" (every
  // caller reads availableSeats = 5 before anyone's UPDATE lands), which is
  // itself the overbooking bug — recorded here, not asserted away.
  assert.equal(
    reservedCount,
    20,
    `expected the naive implementation to overbook (all 20 callers reading ` +
      `stale availableSeats before any UPDATE lands) — got ${reservedCount} ` +
      `"reserved" outcomes instead; DAY-39.md records the actual numbers observed`,
  );

  // Lost update: every racer computed "5 - 1 = 4" from the same stale read,
  // so the last UPDATE to land wins and available_seats ends at 4 — not 0,
  // and not -15 — even though the application logic "let" 20 bookings through.
  assert.equal(afterFlight?.availableSeats, 4);
});
