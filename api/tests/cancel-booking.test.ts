import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import type { BookingAccessScope } from "../src/bookings/booking-repository.js";
import { createCancelBooking } from "../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import type { Actor, Flight } from "../src/types.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";
import { makeFlight as makeFixtureFlight } from "./fixtures/flights.js";

const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");
const FLIGHT_ID = "f1f1f1f1-0000-4000-8000-000000000001";
const BOOKING_ID = "b0b0b0b0-0000-4000-8000-000000000001";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const ACTOR_A: Actor = { accountId: ACCOUNT_A };
const ACTOR_B: Actor = { accountId: ACCOUNT_B };
const SCOPE_A: BookingAccessScope = { kind: "owner", accountId: ACCOUNT_A };
const SCOPE_B: BookingAccessScope = { kind: "owner", accountId: ACCOUNT_B };

/** An OPEN flight departing in 2027, well after FIXED_TIME. */
function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return makeFixtureFlight({ id: FLIGHT_ID, availableSeats: 5, ...overrides });
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
    generateId: () => BOOKING_ID,
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

  const created = await createBooking(FLIGHT_ID, { passengerName: "Alice" }, ACTOR_A);
  assert.equal(created.outcome, "created");
  assert.equal(
    (await flightRepository.findById(FLIGHT_ID))?.availableSeats,
    4,
  );

  const cancelled = await cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(
    (await flightRepository.findById(FLIGHT_ID))?.availableSeats,
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
    generateId: () => BOOKING_ID,
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

  await createBooking(FLIGHT_ID, { passengerName: "Alice" }, ACTOR_A);
  const first = await cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);
  const second = await cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);

  assert.equal(first.outcome, "cancelled");
  assert.equal(second.outcome, "already-cancelled");
  assert.equal(
    (await flightRepository.findById(FLIGHT_ID))?.availableSeats,
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

  const result = await cancelBooking(
    "c0ffee00-0000-4000-8000-000000000000",
    SCOPE_A,
    ACTOR_A,
  );
  assert.equal(result.outcome, "not-found");
  assert.equal(entries.length, 0);

  const malformed = await cancelBooking("not-a-uuid", SCOPE_A, ACTOR_A);
  assert.equal(malformed.outcome, "not-found");
});

test("another account cannot cancel the booking: not-found, booking stays active, nothing released or recorded", async () => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
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

  await createBooking(FLIGHT_ID, { passengerName: "Alice" }, ACTOR_A);

  const result = await cancelBooking(BOOKING_ID, SCOPE_B, ACTOR_B);

  assert.deepEqual(result, { outcome: "not-found" });
  assert.equal(bookingRepository.peek(BOOKING_ID)?.status, "active");
  assert.equal((await flightRepository.findById(FLIGHT_ID))?.availableSeats, 4);
  assert.equal(records.filter((r) => r.action === "BOOKING_CANCELLED").length, 0);
  assert.equal(entries.filter((e) => e.eventType === "booking-cancelled").length, 0);
});

test("cancel records the acting account in the audit log", async () => {
  const { bookingRepository, transactionRunner } = await createTestRuntime();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
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

  await createBooking(FLIGHT_ID, { passengerName: "Alice" }, ACTOR_A);
  await cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);

  const cancelRecord = records.find((r) => r.action === "BOOKING_CANCELLED");
  assert.deepEqual(cancelRecord?.actor, { type: "account", id: ACCOUNT_A });
});
