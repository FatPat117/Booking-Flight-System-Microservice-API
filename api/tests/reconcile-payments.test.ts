import assert from "node:assert/strict";
import test from "node:test";

import type { Booking, BookingAccessScope } from "../src/bookings/booking-repository.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { vnd } from "../src/money/money.js";
import type { Logger, LogFields } from "../src/observability/logger.js";
import type { ChargeRequest } from "../src/payments/payment-gateway.js";
import { createPayForBooking } from "../src/payments/pay-for-booking.js";
import {
  createReconcilePayments,
  PAYMENT_RECONCILIATION_ACTOR,
} from "../src/payments/reconcile-payments.js";
import { BOOKING_CONFIRMED_QUEUE } from "../src/payments/settle-payment.js";
import type { Actor } from "../src/types.js";
import {
  createFakePaymentGateway,
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryIdempotencyRepository,
  createInMemoryOutboxRepository,
  createInMemoryPaymentRepository,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";
import { FIXTURE_ACCOUNT_A } from "./fixtures/bookings.js";
import { makeFlight } from "./fixtures/flights.js";

const HELD_AT = new Date("2026-10-20T00:00:00.000Z");
const DEADLINE = new Date(HELD_AT.getTime() + 15 * 60_000);
const PAY_AT = new Date(HELD_AT.getTime() + 60_000);
/** Gateway timeout + reconciliation margin; also the lease. */
const RECONCILE_AFTER_MS = 40_000;
const DUE_AT = new Date(PAY_AT.getTime() + RECONCILE_AFTER_MS);
const MINUTE_MS = 60_000;
const ACTOR_A: Actor = { accountId: FIXTURE_ACCOUNT_A };
const SCOPE_A: BookingAccessScope = { kind: "owner", accountId: FIXTURE_ACCOUNT_A };
const TOTAL = vnd(3_000_000);
const PAYMENT_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Bookings held at HELD_AT, paid through the real request use case at PAY_AT,
 * then reconciled — the request and the job share every fake, as they share
 * the database in production. Tests move `clock.now`.
 */
async function createRuntime(
  options: { onCharge?: (request: ChargeRequest) => void | Promise<void> } = {},
) {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const paymentRepository = createInMemoryPaymentRepository();
  const idempotencyRepository = createInMemoryIdempotencyRepository();
  const auditRecorder = createInMemoryAuditRecorder();
  const outboxRepository = createInMemoryOutboxRepository();
  const transactionRunner = createInMemoryTransactionRunner();
  const gateway = createFakePaymentGateway(
    options.onCharge === undefined ? {} : { onCharge: options.onCharge },
  );
  const logs: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const push = (level: string) => (message: string, fields?: LogFields) => {
    logs.push(fields === undefined ? { level, message } : { level, message, fields });
  };
  const logger: Logger = { info: push("info"), warn: push("warn"), error: push("error") };
  const clock = { now: HELD_AT };
  let sequence = 0;
  const nextId = () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`;

  const flight = makeFlight({ availableSeats: 6 });
  await flightRepository.create(flight);
  let references = 0;
  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder: createInMemoryAuditRecorder(),
    outboxRepository: createInMemoryOutboxRepository(),
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateReference: () => `REC00${(references += 1)}`,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => HELD_AT,
  });
  async function holdBooking(): Promise<Booking> {
    const created = await createBooking(
      flight.id,
      { passengers: [{ name: "Alice" }, { name: "Bob" }] },
      ACTOR_A,
    );
    assert.equal(created.outcome, "created");
    return (created as { booking: Booking }).booking;
  }

  const shared = {
    bookingRepository,
    paymentRepository,
    idempotencyRepository,
    paymentGateway: gateway,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    logger,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => clock.now,
  };
  const payForBooking = createPayForBooking({
    ...shared,
    generatePaymentId: nextId,
    reconcileAfterMs: RECONCILE_AFTER_MS,
  });
  const reconcilePayments = createReconcilePayments({
    ...shared,
    leaseMs: RECONCILE_AFTER_MS,
    batchSize: 20,
    maxBatches: 5,
  });

  function pay(booking: Booking, key = "key-1") {
    return payForBooking(booking.id, SCOPE_A, ACTOR_A, {
      idempotencyKey: key,
      fingerprint: `fp-${key}`,
      paymentMethodToken: "tok_success",
      amount: TOTAL,
    });
  }

  /** A booking whose payment was left PROCESSING at PAY_AT by an unknown answer. */
  async function processingPayment(script: "unknown" | "lost-response") {
    const booking = await holdBooking();
    gateway.willCharge(
      script === "unknown" ? { outcome: "unknown", reason: "timeout" } : { outcome: "lost-response" },
    );
    clock.now = PAY_AT;
    const result = await pay(booking);
    assert.equal(result.outcome, "processing");
    return booking;
  }

  /** A payment the job charged after the deadline: REFUND_PENDING, refund not tried. */
  async function refundPendingPayment() {
    const booking = await processingPayment("lost-response");
    clock.now = DEADLINE;
    const run = await reconcilePayments();
    assert.equal(run.settled, 1);
    assert.equal((await paymentRepository.findById(PAYMENT_ID))?.status, "REFUND_PENDING");
    return booking;
  }

  return {
    clock,
    gateway,
    logs,
    auditRecorder,
    outboxRepository,
    bookingRepository,
    paymentRepository,
    holdBooking,
    pay,
    processingPayment,
    refundPendingPayment,
    reconcilePayments,
    payment: () => paymentRepository.findById(PAYMENT_ID),
  };
}

const NOTHING_DONE = {
  settled: 0,
  refunded: 0,
  refundFailed: 0,
  retryLater: 0,
  failed: 0,
  batches: 1,
  exhausted: false,
};

test("a PROCESSING payment is not touched before its reconciliation time, so a request still running is left alone", async () => {
  const runtime = await createRuntime();
  await runtime.processingPayment("unknown");
  runtime.clock.now = new Date(DUE_AT.getTime() - 1);

  assert.deepEqual(await runtime.reconcilePayments(), NOTHING_DONE);
  assert.equal((await runtime.payment())?.attempts, 0);
  assert.equal(runtime.gateway.charges.length, 1);
});

test("a lost response: the job charges the same payment id again, gets the first charge back, confirms the booking and completes the key with 201 — money taken once", async () => {
  const runtime = await createRuntime();
  const booking = await runtime.processingPayment("lost-response");
  runtime.clock.now = DUE_AT;

  const run = await runtime.reconcilePayments();

  assert.deepEqual(run, { ...NOTHING_DONE, settled: 1 });
  assert.deepEqual(
    runtime.gateway.charges.map(({ paymentId, paymentMethodToken }) => `${paymentId}:${paymentMethodToken}`),
    [`${PAYMENT_ID}:tok_success`, `${PAYMENT_ID}:tok_success`],
  );
  assert.deepEqual(runtime.gateway.ledger.charged, [PAYMENT_ID]);
  assert.equal(runtime.bookingRepository.peek(booking.id)?.status, "CONFIRMED");
  const payment = await runtime.payment();
  assert.equal(payment?.status, "SUCCEEDED");
  assert.equal(payment?.paymentMethodToken, null);
  assert.equal(payment?.nextAttemptAt, null);

  const replay = await runtime.pay(booking);
  assert.equal(replay.outcome, "answered");
  assert.equal(replay.outcome === "answered" && replay.replayed, true);
  assert.equal(replay.outcome === "answered" && replay.response.status, 201);

  assert.deepEqual(
    runtime.auditRecorder.records.map(({ action, actor }) => `${action}:${actor.type}/${actor.id}`),
    [`BOOKING_CONFIRMED:system/${PAYMENT_RECONCILIATION_ACTOR.id}`],
  );
  assert.deepEqual(
    runtime.outboxRepository.entries.map(({ eventType }) => eventType),
    [BOOKING_CONFIRMED_QUEUE],
  );
});

test("a charge that never reached the provider is made by the job, once", async () => {
  const runtime = await createRuntime();
  const booking = await runtime.processingPayment("unknown");
  assert.deepEqual(runtime.gateway.ledger.charged, []);
  runtime.clock.now = DUE_AT;

  await runtime.reconcilePayments();

  assert.deepEqual(runtime.gateway.ledger.charged, [PAYMENT_ID]);
  assert.equal(runtime.bookingRepository.peek(booking.id)?.status, "CONFIRMED");
});

test("a decline at reconciliation is FAILED, the key answers 402, and the booking stays HELD", async () => {
  const runtime = await createRuntime();
  const booking = await runtime.processingPayment("unknown");
  runtime.gateway.willCharge({ outcome: "declined", reason: "card_declined" });
  runtime.clock.now = DUE_AT;

  await runtime.reconcilePayments();

  const payment = await runtime.payment();
  assert.equal(payment?.status, "FAILED");
  assert.equal(payment?.failureReason, "card_declined");
  assert.equal(runtime.bookingRepository.peek(booking.id)?.status, "HELD");
  const replay = await runtime.pay(booking);
  assert.equal(replay.outcome === "answered" && replay.response.status, 402);
});

test("a charge the job gets after the hold lapsed is left for refund, refunded on the next run, and the key answers 409", async () => {
  const runtime = await createRuntime();
  const booking = await runtime.refundPendingPayment();
  assert.deepEqual(runtime.gateway.refunds, []);

  const run = await runtime.reconcilePayments();

  assert.deepEqual(run, { ...NOTHING_DONE, refunded: 1 });
  const payment = await runtime.payment();
  assert.equal(payment?.status, "REFUNDED");
  assert.equal(payment?.nextAttemptAt, null);
  assert.deepEqual(runtime.gateway.ledger, { charged: [PAYMENT_ID], refunded: [PAYMENT_ID] });
  const replay = await runtime.pay(booking);
  assert.equal(replay.outcome === "answered" && replay.response.status, 409);
  assert.deepEqual(
    runtime.auditRecorder.records.map(({ action, actor }) => `${action}:${actor.id}`),
    [
      `PAYMENT_REFUND_PENDING:${PAYMENT_RECONCILIATION_ACTOR.id}`,
      `PAYMENT_REFUNDED:${PAYMENT_RECONCILIATION_ACTOR.id}`,
    ],
  );
});

test("an outcome still unknown stays PROCESSING, never FAILED: each attempt is counted and retried 1, 2, 4 minutes later, with a warning from the third (BR-PAY-08)", async () => {
  const runtime = await createRuntime();
  await runtime.processingPayment("unknown");
  const timeout = { outcome: "unknown", reason: "timeout" } as const;
  runtime.gateway.willCharge(timeout, timeout, timeout);
  let at = DUE_AT;

  const retries: Array<{ attempts: number; inMinutes: number }> = [];
  for (let run = 0; run < 3; run += 1) {
    runtime.clock.now = at;
    assert.deepEqual(await runtime.reconcilePayments(), { ...NOTHING_DONE, retryLater: 1 });
    const payment = await runtime.payment();
    assert.equal(payment?.status, "PROCESSING");
    const next = new Date(payment?.nextAttemptAt ?? "");
    retries.push({
      attempts: payment?.attempts ?? 0,
      inMinutes: (next.getTime() - at.getTime()) / MINUTE_MS,
    });
    at = next;
  }

  assert.deepEqual(retries, [
    { attempts: 1, inMinutes: 1 },
    { attempts: 2, inMinutes: 2 },
    { attempts: 3, inMinutes: 4 },
  ]);
  assert.deepEqual(
    runtime.logs.filter(({ level }) => level !== "info").map(({ message }) => message),
    ["payment_outcome_unknown", "payment_outcome_still_unknown"],
  );
  assert.deepEqual(runtime.gateway.ledger.charged, []);
});

test("a refund that fails twice is retried after 1 and 2 minutes, then REFUNDED", async () => {
  const runtime = await createRuntime();
  await runtime.refundPendingPayment();
  const unavailable = { outcome: "failed", reason: "provider_unavailable", retryable: true } as const;
  runtime.gateway.willRefund(unavailable, { outcome: "unknown", reason: "timeout" });

  assert.deepEqual(await runtime.reconcilePayments(), { ...NOTHING_DONE, retryLater: 1 });
  assert.equal((await runtime.payment())?.nextAttemptAt, new Date(DEADLINE.getTime() + MINUTE_MS).toISOString());
  runtime.clock.now = new Date(DEADLINE.getTime() + MINUTE_MS);
  assert.deepEqual(await runtime.reconcilePayments(), { ...NOTHING_DONE, retryLater: 1 });
  assert.equal(
    (await runtime.payment())?.nextAttemptAt,
    new Date(DEADLINE.getTime() + 3 * MINUTE_MS).toISOString(),
  );
  runtime.clock.now = new Date(DEADLINE.getTime() + 3 * MINUTE_MS);
  assert.deepEqual(await runtime.reconcilePayments(), { ...NOTHING_DONE, refunded: 1 });

  assert.equal((await runtime.payment())?.status, "REFUNDED");
  assert.equal(runtime.gateway.refunds.length, 3);
  assert.deepEqual(
    runtime.logs.filter(({ message }) => message === "payment_refund_retry").length,
    2,
  );
});

test("a refund the gateway calls permanent is REFUND_FAILED at once, audited, and logged as an error for a person (BR-PAY-09)", async () => {
  const runtime = await createRuntime();
  const booking = await runtime.refundPendingPayment();
  runtime.gateway.willRefund({ outcome: "failed", reason: "card_account_closed", retryable: false });

  assert.deepEqual(await runtime.reconcilePayments(), { ...NOTHING_DONE, refundFailed: 1 });

  const payment = await runtime.payment();
  assert.equal(payment?.status, "REFUND_FAILED");
  assert.equal(payment?.failureReason, "card_account_closed");
  assert.equal(payment?.nextAttemptAt, null);
  assert.deepEqual(runtime.logs.filter(({ level }) => level === "error"), [
    {
      level: "error",
      message: "payment_refund_needs_attention",
      fields: { paymentId: PAYMENT_ID, bookingId: booking.id, attempts: 1, reason: "card_account_closed" },
    },
  ]);
  assert.equal(runtime.auditRecorder.records.at(-1)?.action, "PAYMENT_REFUND_FAILED");
  // Nothing is due any more: the job leaves it to people.
  runtime.clock.now = new Date(DEADLINE.getTime() + 60 * MINUTE_MS);
  assert.deepEqual(await runtime.reconcilePayments(), NOTHING_DONE);
});

test("a refund still failing at its fifth attempt is REFUND_FAILED: four retries, never a sixth call (BR-PAY-09)", async () => {
  const runtime = await createRuntime();
  await runtime.refundPendingPayment();
  const unavailable = { outcome: "failed", reason: "provider_unavailable", retryable: true } as const;
  runtime.gateway.willRefund(unavailable, unavailable, unavailable, unavailable, unavailable, unavailable);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await runtime.reconcilePayments();
    const next = (await runtime.payment())?.nextAttemptAt;
    if (next !== null && next !== undefined) {
      runtime.clock.now = new Date(next);
    }
  }
  runtime.clock.now = new Date(runtime.clock.now.getTime() + 60 * MINUTE_MS);
  await runtime.reconcilePayments();

  assert.equal((await runtime.payment())?.status, "REFUND_FAILED");
  assert.equal(runtime.gateway.refunds.length, 5);
  assert.deepEqual(runtime.gateway.ledger.refunded, []);
});

test("a payment that throws is logged and skipped; the rest of the batch is still reconciled", async () => {
  const runtime = await createRuntime({
    onCharge: (request) => {
      if (request.paymentId === PAYMENT_ID && runtime.clock.now >= DUE_AT) {
        throw new Error("connection reset");
      }
    },
  });
  await runtime.processingPayment("unknown");
  const other = await runtime.holdBooking();
  runtime.gateway.willCharge({ outcome: "unknown", reason: "timeout" });
  await runtime.pay(other, "key-2");
  runtime.clock.now = DUE_AT;

  assert.deepEqual(await runtime.reconcilePayments(), { ...NOTHING_DONE, settled: 1, failed: 1 });

  assert.equal((await runtime.payment())?.status, "PROCESSING");
  assert.equal(runtime.bookingRepository.peek(other.id)?.status, "CONFIRMED");
  assert.deepEqual(
    runtime.logs.filter(({ level }) => level === "error").map(({ message, fields }) => [message, fields?.paymentId]),
    [["payment_reconciliation_failed", PAYMENT_ID]],
  );
});
