import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import { createCancelBooking } from "../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { createSqliteBookingRepository } from "../src/bookings/sqlite-booking-repository.js";
import { openDatabase } from "../src/database.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import { createSqliteTransactionRunner } from "../src/transactions/sqlite-transaction-runner.js";
import type { Flight } from "../src/types.js";

const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T01:00:00.000Z",
    arrivalAt: "2026-08-10T03:00:00.000Z",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 5,
    ...overrides,
  };
}

function createCapturingAuditRecorder() {
  const records: AuditRecordInput[] = [];

  const auditRecorder: AuditRecorder = {
    record(input) {
      records.push(input);
    },
  };

  return { auditRecorder, records };
}

function createCapturingOutboxRepository() {
  const entries: OutboxEntry[] = [];

  const outboxRepository: OutboxRepository = {
    async enqueue(entry) {
      entries.push(entry);
    },
    async findUnpublished() {
      return [];
    },
    async markPublished() {},
  };

  return { outboxRepository, entries };
}

async function createTestRuntime(t: TestContext, availableSeats = 5) {
  const database = openDatabase(":memory:");
  const flightRepository = createSqliteFlightRepository(database);
  const bookingRepository = createSqliteBookingRepository(database);
  const transactionRunner = createSqliteTransactionRunner(database);

  await flightRepository.create(makeFlight({ availableSeats }));

  t.after(() => {
    database.close();
  });

  return {
    database,
    flightRepository,
    bookingRepository,
    transactionRunner,
  };
}

test("cancels booking, releases seat, audits and enqueues outbox", async (t) => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime(t);
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => "fixed-booking-id",
    generateAuditId: () => "create-audit-id",
    generateOutboxId: () => "create-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => "cancel-audit-id",
    generateOutboxId: () => "cancel-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const created = await createBooking("flight-1", { passengerName: "Alice" });
  assert.equal(created.outcome, "created");
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    4,
  );

  const cancelled = await cancelBooking("fixed-booking-id");
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    5,
  );

  const cancelOutbox = entries.filter((e) => e.eventType === "booking-cancelled");
  assert.equal(cancelOutbox.length, 1);
  assert.equal(records.filter((r) => r.action === "BOOKING_CANCELLED").length, 1);
});

test("second cancel is already-cancelled and does not release another seat", async (t) => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime(t);
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => "fixed-booking-id",
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  await createBooking("flight-1", { passengerName: "Alice" });
  const first = await cancelBooking("fixed-booking-id");
  const second = await cancelBooking("fixed-booking-id");

  assert.equal(first.outcome, "cancelled");
  assert.equal(second.outcome, "already-cancelled");
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    5,
  );
  assert.equal(
    entries.filter((e) => e.eventType === "booking-cancelled").length,
    1,
  );
});

test("concurrent double-cancel releases seat only once", async (t) => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime(t, 5);
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => "fixed-booking-id",
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const created = await createBooking("flight-1", { passengerName: "Alice" });
  assert.equal(created.outcome, "created");
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    4,
  );

  const [first, second] = await Promise.all([
    cancelBooking("fixed-booking-id"),
    cancelBooking("fixed-booking-id"),
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ["already-cancelled", "cancelled"]);
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    5,
  );
});

test("cancel returns not-found for missing booking", async (t) => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime(t);
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const cancelBooking = createCancelBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => "cancel-audit-id",
    generateOutboxId: () => "cancel-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await cancelBooking("missing-booking");
  assert.equal(result.outcome, "not-found");
  assert.equal(entries.length, 0);
});
