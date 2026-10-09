import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import type { BookingRepository } from "../src/bookings/booking-repository.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import type { Actor, Flight } from "../src/types.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");
const FLIGHT_ID = "f1f1f1f1-0000-4000-8000-000000000001";
const BOOKING_ID = "b0b0b0b0-0000-4000-8000-000000000001";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACTOR_A: Actor = { accountId: ACCOUNT_A };

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: FLIGHT_ID,
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T01:00:00.000Z",
    arrivalAt: "2026-08-10T03:00:00.000Z",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 1,
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

async function createTestRuntime(availableSeats = 1) {
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

test("creates booking with audit and outbox when seat is available", async () => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(
    FLIGHT_ID,
    { passengerName: " Alice " },
    ACTOR_A,
  );

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }

  assert.equal(result.booking.passengerName, "Alice");
  assert.equal(result.booking.ownerAccountId, ACCOUNT_A);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.eventType, "booking-created");
  assert.deepEqual(entries[0]?.payload, {
    eventId: "fixed-outbox-id",
    correlationId: "fixed-request-id",
    type: "booking.created",
    occurredAt: "2026-07-20T00:00:00.000Z",
    booking: {
      id: result.booking.id,
      flightId: result.booking.flightId,
      passengerName: result.booking.passengerName,
      createdAt: result.booking.createdAt,
    },
  });
  assert.equal(result.booking.status, "active");
  assert.deepEqual(records, [
    {
      id: "fixed-audit-id",
      action: "BOOKING_CREATED",
      actor: { type: "account", id: ACCOUNT_A },
      target: { type: "booking", id: BOOKING_ID },
      requestId: "fixed-request-id",
      occurredAt: "2026-07-20T00:00:00.000Z",
      metadata: {
        flightId: FLIGHT_ID,
        passengerName: "Alice",
        correlationId: "fixed-request-id",
      },
    },
  ]);
});

test("booking outbox correlationId falls back to eventId when requestId is missing", async () => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime();
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(FLIGHT_ID, { passengerName: "Alice" }, ACTOR_A);
  assert.equal(result.outcome, "created");
  assert.equal(
    (entries[0]?.payload as { correlationId: string }).correlationId,
    "fixed-outbox-id",
  );
});

test("returns sold-out without outbox when no seats remain", async () => {
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
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const first = await createBooking(FLIGHT_ID, { passengerName: "Alice" }, ACTOR_A);
  const second = await createBooking(FLIGHT_ID, { passengerName: "Bob" }, ACTOR_A);

  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "sold-out");
  assert.equal(entries.length, 1);
  assert.equal(records.length, 1);
  assert.equal(
    (await flightRepository.findById(FLIGHT_ID))?.availableSeats,
    0,
  );
});

test("returns flight-not-found without outbox for missing flight", async () => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(
    "c0ffee00-0000-4000-8000-000000000000",
    { passengerName: "Alice" },
    ACTOR_A,
  );

  assert.equal(result.outcome, "flight-not-found");
  assert.equal(entries.length, 0);
  assert.equal(records.length, 0);
});

test("a malformed flight id is flight-not-found, never sent to the repository", async () => {
  const { transactionRunner } = await createTestRuntime();
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository } = createCapturingOutboxRepository();
  let repositoryCalls = 0;
  const bookingRepository: BookingRepository = {
    async reserveSeat() {
      repositoryCalls += 1;
      return { outcome: "reserved" };
    },
    async create() {
      repositoryCalls += 1;
    },
    async findById() {
      repositoryCalls += 1;
      return undefined;
    },
    async findPage() {
      repositoryCalls += 1;
      return { items: [], totalItems: 0 };
    },
    async cancel() {
      repositoryCalls += 1;
      return { outcome: "not-found" };
    },
    async releaseSeat() {
      repositoryCalls += 1;
    },
  };

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking("not-a-uuid", { passengerName: "Alice" }, ACTOR_A);

  assert.deepEqual(result, { outcome: "flight-not-found" });
  assert.equal(repositoryCalls, 0);
});
