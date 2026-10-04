import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import { createCancelBooking } from "../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import type { Flight } from "../src/types.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

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
    async record(input) {
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

async function createTestRuntime(availableSeats = 5) {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const transactionRunner = createInMemoryTransactionRunner();

  await flightRepository.create(makeFlight({ availableSeats }));

  return {
    flightRepository,
    bookingRepository,
    transactionRunner,
  };
}

test("cancels booking, releases seat, audits and enqueues outbox", async () => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime();
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

test("second cancel is already-cancelled and does not release another seat", async () => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime();
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

test("cancel returns not-found for missing booking", async () => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime();
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
