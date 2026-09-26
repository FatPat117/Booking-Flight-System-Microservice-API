import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { createSqliteBookingRepository } from "../src/bookings/sqlite-booking-repository.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import { openDatabase } from "../src/database.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
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

async function createTestRuntime(t: TestContext, availableSeats = 1) {
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

test("creates booking with audit and outbox when seat is available", async (t) => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime(t);
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => "fixed-booking-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking("flight-1", {
    passengerName: " Alice ",
  });

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }

  assert.equal(result.booking.passengerName, "Alice");
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
      actor: { type: "passenger", id: "anonymous" },
      target: { type: "booking", id: "fixed-booking-id" },
      requestId: "fixed-request-id",
      occurredAt: "2026-07-20T00:00:00.000Z",
      metadata: {
        flightId: "flight-1",
        passengerName: "Alice",
        correlationId: "fixed-request-id",
      },
    },
  ]);
});

test("booking outbox correlationId falls back to eventId when requestId is missing", async (t) => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime(t);
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => "fixed-booking-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking("flight-1", { passengerName: "Alice" });
  assert.equal(result.outcome, "created");
  assert.equal(
    (entries[0]?.payload as { correlationId: string }).correlationId,
    "fixed-outbox-id",
  );
});

test("returns sold-out without outbox when no seats remain", async (t) => {
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
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const first = await createBooking("flight-1", { passengerName: "Alice" });
  const second = await createBooking("flight-1", { passengerName: "Bob" });

  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "sold-out");
  assert.equal(entries.length, 1);
  assert.equal(records.length, 1);
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    0,
  );
});

test("returns flight-not-found without outbox for missing flight", async (t) => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime(t);
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => "fixed-booking-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking("missing-flight", {
    passengerName: "Alice",
  });

  assert.equal(result.outcome, "flight-not-found");
  assert.equal(entries.length, 0);
  assert.equal(records.length, 0);
});

test("concurrent bookings with one seat yield one created and one sold-out", async (t) => {
  const database = openDatabase(":memory:");
  const flightRepository = createSqliteFlightRepository(database);
  const bookingRepository = createSqliteBookingRepository(database);
  const transactionRunner = createSqliteTransactionRunner(database);
  const { outboxRepository } = createCapturingOutboxRepository();
  const { auditRecorder } = createCapturingAuditRecorder();

  await flightRepository.create(makeFlight({ availableSeats: 1 }));

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  t.after(() => {
    database.close();
  });

  const [first, second] = await Promise.all([
    createBooking("flight-1", { passengerName: "Alice" }),
    createBooking("flight-1", { passengerName: "Bob" }),
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ["created", "sold-out"]);
  assert.equal(
    (await flightRepository.findById("flight-1"))?.availableSeats,
    0,
  );

  const bookingCount = database
    .prepare("SELECT COUNT(*) AS count FROM bookings")
    .get() as { count: number | bigint };
  const count =
    typeof bookingCount.count === "bigint"
      ? Number(bookingCount.count)
      : bookingCount.count;
  assert.equal(count, 1);
});
