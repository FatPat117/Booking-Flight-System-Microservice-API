import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import type { BookingAccessScope } from "../src/bookings/booking-repository.js";
import { createCancelBooking } from "../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import type { BookingCancelledEvent } from "@booking-flight-system/contracts";

import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import type { Actor, Flight } from "../src/types.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryPaymentRepository,
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
    generateReference: () => "K7Q4PZ",
    generateAuditId: () => "create-audit-id",
    generateOutboxId: () => "create-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    paymentRepository: createInMemoryPaymentRepository(),
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => "cancel-audit-id",
    generateOutboxId: () => "cancel-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const created = await createBooking(FLIGHT_ID, { fareClass: "ECONOMY", passengers: [{ name: "Alice" }] }, ACTOR_A);
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
    generateReference: () => "K7Q4PZ",
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    paymentRepository: createInMemoryPaymentRepository(),
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  await createBooking(FLIGHT_ID, { fareClass: "ECONOMY", passengers: [{ name: "Alice" }] }, ACTOR_A);
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

test("cancelling a hold at its deadline is expired: nothing recorded, the seat stays held for the job", async () => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();
  const deadline = new Date(FIXED_TIME.getTime() + 15 * 60 * 1000);

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => "K7Q4PZ",
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    paymentRepository: createInMemoryPaymentRepository(),
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => deadline,
  });

  await createBooking(FLIGHT_ID, { fareClass: "ECONOMY", passengers: [{ name: "Alice" }] }, ACTOR_A);
  const writesBefore = { records: records.length, entries: entries.length };

  assert.deepEqual(await cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A), { outcome: "expired" });
  assert.deepEqual({ records: records.length, entries: entries.length }, writesBefore);
  assert.equal((await flightRepository.findById(FLIGHT_ID))?.availableSeats, 4);
});

test("cancel returns not-found for missing booking", async () => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime();
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const cancelBooking = createCancelBooking({
    bookingRepository,
    paymentRepository: createInMemoryPaymentRepository(),
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
    generateReference: () => "K7Q4PZ",
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    paymentRepository: createInMemoryPaymentRepository(),
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  await createBooking(FLIGHT_ID, { fareClass: "ECONOMY", passengers: [{ name: "Alice" }] }, ACTOR_A);

  const result = await cancelBooking(BOOKING_ID, SCOPE_B, ACTOR_B);

  assert.deepEqual(result, { outcome: "not-found" });
  assert.equal(bookingRepository.peek(BOOKING_ID)?.status, "HELD");
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
    generateReference: () => "K7Q4PZ",
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    paymentRepository: createInMemoryPaymentRepository(),
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  await createBooking(FLIGHT_ID, { fareClass: "ECONOMY", passengers: [{ name: "Alice" }] }, ACTOR_A);
  await cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);

  const cancelRecord = records.find((r) => r.action === "BOOKING_CANCELLED");
  assert.deepEqual(cancelRecord?.actor, { type: "account", id: ACCOUNT_A });
});

// ---------------------------------------------------------------------------
// Cancelling a CONFIRMED booking (Day 50, BR-BOOK-06, Decision 16)
// ---------------------------------------------------------------------------

const PAYMENT_ID = "c0c0c0c0-0000-4000-8000-000000000001";
const DEPARTURE = "2026-08-01T10:00:00.000Z";
/** departure − 24 h: the first instant the window is closed. */
const WINDOW_CLOSES = new Date("2026-07-31T10:00:00.000Z");

/**
 * A CONFIRMED booking with a SUCCEEDED payment, as payment phase 3 leaves
 * it, on a flight departing at DEPARTURE; cancelled at `cancelAt`.
 */
async function createPaidBooking(cancelAt: Date, options: { paid?: boolean } = {}) {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const paymentRepository = createInMemoryPaymentRepository();
  const transactionRunner = createInMemoryTransactionRunner();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  await flightRepository.create(
    makeFlight({ departureAt: DEPARTURE, arrivalAt: "2026-08-01T12:00:00.000Z" }),
  );
  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => "K7Q4PZ",
    generateAuditId: () => "create-audit-id",
    generateOutboxId: () => "create-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });
  const created = await createBooking(
    FLIGHT_ID,
    { fareClass: "ECONOMY", passengers: [{ name: "Alice" }, { name: "Bob" }] },
    ACTOR_A,
  );
  assert.equal(created.outcome, "created");

  const confirmed = await bookingRepository.confirmHold(BOOKING_ID, SCOPE_A, FIXED_TIME);
  assert.equal(confirmed.outcome, "confirmed");
  if (confirmed.outcome !== "confirmed") throw new Error("unreachable");
  if (options.paid !== false) {
    await paymentRepository.start({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      accountId: ACCOUNT_A,
      amount: confirmed.booking.total,
      paymentMethodToken: "tok_success",
      nextAttemptAt: FIXED_TIME.toISOString(),
      createdAt: FIXED_TIME.toISOString(),
    });
    await paymentRepository.markSucceeded(PAYMENT_ID, "sim_ch_1", FIXED_TIME);
  }
  records.length = 0;
  entries.length = 0;

  const cancelBooking = createCancelBooking({
    bookingRepository,
    paymentRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: (() => {
      let next = 0;
      return () => `cancel-audit-${++next}`;
    })(),
    generateOutboxId: () => "cancel-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => cancelAt,
  });

  return {
    cancelBooking,
    bookingRepository,
    flightRepository,
    paymentRepository,
    total: confirmed.booking.total,
    records,
    entries,
  };
}

test("cancelling a paid CONFIRMED booking 1 ms before departure − 24 h releases the seats and moves the payment to REFUND_PENDING, due now", async () => {
  const cancelAt = new Date(WINDOW_CLOSES.getTime() - 1);
  const runtime = await createPaidBooking(cancelAt);

  const result = await runtime.cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);

  assert.equal(result.outcome, "cancelled");
  if (result.outcome !== "cancelled") return;
  assert.equal(result.booking.status, "CANCELLED");
  assert.deepEqual(result.refund, { paymentId: PAYMENT_ID, amount: runtime.total });
  assert.equal((await runtime.flightRepository.findById(FLIGHT_ID))?.availableSeats, 5);

  const payment = await runtime.paymentRepository.findById(PAYMENT_ID);
  assert.equal(payment?.status, "REFUND_PENDING");
  assert.equal(payment?.nextAttemptAt, cancelAt.toISOString());
  assert.equal(payment?.attempts, 0);
  assert.equal(payment?.providerReference, "sim_ch_1");
});

test("cancelling a paid booking at exactly departure − 24 h, or 1 ms later, is window-closed and writes nothing", async () => {
  for (const cancelAt of [WINDOW_CLOSES, new Date(WINDOW_CLOSES.getTime() + 1)]) {
    const runtime = await createPaidBooking(cancelAt);

    assert.deepEqual(await runtime.cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A), {
      outcome: "cancellation-window-closed",
      cancellableUntil: "2026-07-31T10:00:00.000Z",
    });
    assert.equal((await runtime.bookingRepository.findById(BOOKING_ID, SCOPE_A))?.status, "CONFIRMED");
    assert.equal((await runtime.flightRepository.findById(FLIGHT_ID))?.availableSeats, 3);
    assert.equal((await runtime.paymentRepository.findById(PAYMENT_ID))?.status, "SUCCEEDED");
    assert.deepEqual(runtime.records, []);
    assert.deepEqual(runtime.entries, []);
  }
});

test("a paid cancel records BOOKING_CANCELLED with the refund's payment and PAYMENT_REFUND_PENDING, both by the owner", async () => {
  const runtime = await createPaidBooking(FIXED_TIME);

  await runtime.cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);

  assert.deepEqual(
    runtime.records.map(({ action, actor, target, metadata }) => ({ action, actor, target, metadata })),
    [
      {
        action: "BOOKING_CANCELLED",
        actor: { type: "account", id: ACCOUNT_A },
        target: { type: "booking", id: BOOKING_ID },
        metadata: {
          flightId: FLIGHT_ID,
          correlationId: "fixed-request-id",
          refundPaymentId: PAYMENT_ID,
        },
      },
      {
        action: "PAYMENT_REFUND_PENDING",
        actor: { type: "account", id: ACCOUNT_A },
        target: { type: "payment", id: PAYMENT_ID },
        metadata: {
          bookingId: BOOKING_ID,
          amountVnd: runtime.total.amount,
          providerReference: "sim_ch_1",
          reason: "booking-cancelled",
        },
      },
    ],
  );
});

test("booking-cancelled carries the reference, the released seats and the refund; no passenger names", async () => {
  const runtime = await createPaidBooking(FIXED_TIME);

  await runtime.cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);

  assert.equal(runtime.entries.length, 1);
  const expected: BookingCancelledEvent = {
    eventId: "cancel-outbox-id",
    correlationId: "fixed-request-id",
    type: "booking.cancelled",
    occurredAt: FIXED_TIME.toISOString(),
    booking: { id: BOOKING_ID, reference: "K7Q4PZ", flightId: FLIGHT_ID, seats: ["1A", "1B"] },
    refund: { paymentId: PAYMENT_ID, amount: { amount: runtime.total.amount, currency: "VND" } },
  };
  assert.deepEqual(runtime.entries[0]?.payload, expected);
});

test("a CONFIRMED booking with no SUCCEEDED payment (legacy) is cancelled with refund null and no payment audit", async () => {
  const runtime = await createPaidBooking(FIXED_TIME, { paid: false });

  const result = await runtime.cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);

  assert.equal(result.outcome, "cancelled");
  if (result.outcome !== "cancelled") return;
  assert.equal(result.refund, null);
  assert.deepEqual(runtime.records.map(({ action }) => action), ["BOOKING_CANCELLED"]);
  assert.equal((runtime.entries[0]?.payload as BookingCancelledEvent).refund, null);
});

test("a paid booking cancelled twice starts one refund: the second cancel is already-cancelled and leaves the payment alone", async () => {
  const runtime = await createPaidBooking(FIXED_TIME);
  await runtime.cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A);
  const records = runtime.records.length;

  assert.deepEqual(await runtime.cancelBooking(BOOKING_ID, SCOPE_A, ACTOR_A), {
    outcome: "already-cancelled",
  });
  assert.equal((await runtime.paymentRepository.findById(PAYMENT_ID))?.status, "REFUND_PENDING");
  assert.equal(runtime.records.length, records);
});
