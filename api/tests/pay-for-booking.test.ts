import assert from "node:assert/strict";
import test from "node:test";

import { parseBookingConfirmedEvent } from "@booking-flight-system/contracts";
import type {
  Booking,
  BookingAccessScope,
} from "../src/bookings/booking-repository.js";
import { createCancelBooking } from "../src/bookings/cancel-booking.js";
import { createCreateBooking } from "../src/bookings/create-booking.js";
import { vnd } from "../src/money/money.js";
import type { Logger } from "../src/observability/logger.js";
import {
  BOOKING_CONFIRMED_QUEUE,
  createPayForBooking,
  PAYMENT_REFUND_ACTOR,
  type PaymentRequest,
} from "../src/payments/pay-for-booking.js";
import type { Actor, Flight } from "../src/types.js";
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
import { FIXTURE_ACCOUNT_A, FIXTURE_ACCOUNT_B } from "./fixtures/bookings.js";
import { makeFlight } from "./fixtures/flights.js";

/** The hold is made here and lapses 15 minutes later. */
const HELD_AT = new Date("2026-10-20T00:00:00.000Z");
const DEADLINE_MS = HELD_AT.getTime() + 15 * 60_000;
const ACTOR_A: Actor = { accountId: FIXTURE_ACCOUNT_A };
const SCOPE_A: BookingAccessScope = { kind: "owner", accountId: FIXTURE_ACCOUNT_A };
const SCOPE_B: BookingAccessScope = { kind: "owner", accountId: FIXTURE_ACCOUNT_B };
const TOTAL = vnd(3_000_000);

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    idempotencyKey: "key-1",
    fingerprint: "fp-1",
    paymentMethodToken: "tok_success",
    amount: TOTAL,
    ...overrides,
  };
}

/**
 * A HELD booking of two ECONOMY seats (2 × 1 500 000 đ) made at HELD_AT, and
 * a payment use case on fakes whose clock starts one minute later. Tests
 * move `clock.now`; `onCharge` runs inside the gateway call (phase 2).
 */
async function createRuntime(
  options: {
    onCharge?: () => void | Promise<void>;
    flight?: Partial<Flight>;
  } = {},
) {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const transactionRunner = createInMemoryTransactionRunner();
  const auditRecorder = createInMemoryAuditRecorder();
  const outboxRepository = createInMemoryOutboxRepository();
  const paymentRepository = createInMemoryPaymentRepository();
  const idempotencyRepository = createInMemoryIdempotencyRepository();
  const gateway = createFakePaymentGateway(
    options.onCharge === undefined ? {} : { onCharge: options.onCharge },
  );
  const warnings: Array<{ message: string; fields?: unknown }> = [];
  const logger: Logger = {
    info() {},
    warn(message, fields) {
      warnings.push({ message, fields });
    },
    error() {},
  };

  const flight = makeFlight({ availableSeats: 3, ...options.flight });
  await flightRepository.create(flight);

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder: createInMemoryAuditRecorder(),
    outboxRepository: createInMemoryOutboxRepository(),
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateReference: () => "PAY123",
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => HELD_AT,
  });
  const created = await createBooking(
    flight.id,
    { passengers: [{ name: "Alice" }, { name: "Bob" }] },
    ACTOR_A,
  );
  assert.equal(created.outcome, "created");
  const booking = (created as { booking: Booking }).booking;

  const clock = { now: new Date(HELD_AT.getTime() + 60_000) };
  let paymentSequence = 0;

  const dependencies = {
    bookingRepository,
    paymentRepository,
    idempotencyRepository,
    paymentGateway: gateway,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    logger,
    generatePaymentId: () => `00000000-0000-4000-8000-${String((paymentSequence += 1)).padStart(12, "0")}`,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => "request-1",
    getCurrentTime: () => clock.now,
  };

  const cancelBooking = createCancelBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => clock.now,
  });

  return {
    payForBooking: createPayForBooking(dependencies),
    cancelBooking,
    booking,
    flights,
    bookingRepository,
    paymentRepository,
    auditRecorder,
    outboxRepository,
    gateway,
    warnings,
    clock,
  };
}

function seatStatuses(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
): string[] {
  const flightSeats = runtime.flights.seats.get(runtime.booking.flightId) ?? [];
  return flightSeats.map((seat) => `${seat.position.row}${seat.position.letter}:${seat.status}`);
}

const FIRST_PAYMENT_ID = "00000000-0000-4000-8000-000000000001";

test("a successful charge confirms the booking, books its seats, and answers 201 with the payment", async () => {
  const runtime = await createRuntime();
  const { booking } = runtime;

  const result = await runtime.payForBooking(booking.id, SCOPE_A, ACTOR_A, request());

  const confirmed = runtime.bookingRepository.peek(booking.id);
  assert.equal(confirmed?.status, "CONFIRMED");
  assert.deepEqual(result, {
    outcome: "answered",
    replayed: false,
    response: {
      status: 201,
      body: {
        payment: {
          id: FIRST_PAYMENT_ID,
          bookingId: booking.id,
          status: "SUCCEEDED",
          amount: TOTAL,
          providerReference: `fake_ch_${FIRST_PAYMENT_ID}`,
          createdAt: runtime.clock.now.toISOString(),
        },
        booking: confirmed,
      },
    },
  });
  assert.deepEqual(seatStatuses(runtime), ["1A:BOOKED", "1B:BOOKED", "1C:AVAILABLE"]);
  assert.equal((await runtime.paymentRepository.findById(FIRST_PAYMENT_ID))?.status, "SUCCEEDED");
  assert.deepEqual(runtime.gateway.charges, [
    { paymentId: FIRST_PAYMENT_ID, amount: TOTAL, paymentMethodToken: "tok_success" },
  ]);
});

test("a confirmed payment is audited as BOOKING_CONFIRMED by the payer and emits booking-confirmed", async () => {
  const runtime = await createRuntime();
  const { booking } = runtime;

  await runtime.payForBooking(booking.id, SCOPE_A, ACTOR_A, request());

  const [audit] = runtime.auditRecorder.records;
  assert.equal(runtime.auditRecorder.records.length, 1);
  assert.equal(audit?.action, "BOOKING_CONFIRMED");
  assert.deepEqual(audit?.actor, { type: "account", id: FIXTURE_ACCOUNT_A });
  assert.deepEqual(audit?.target, { type: "booking", id: booking.id });
  assert.equal(audit?.requestId, "request-1");
  assert.equal(audit?.metadata.paymentId, FIRST_PAYMENT_ID);
  assert.equal(audit?.metadata.amountVnd, TOTAL.amount);

  const [entry] = runtime.outboxRepository.entries;
  assert.equal(runtime.outboxRepository.entries.length, 1);
  assert.equal(entry?.eventType, BOOKING_CONFIRMED_QUEUE);
  const parsed = parseBookingConfirmedEvent(entry?.payload);
  assert.ok(parsed.ok);
  assert.equal(parsed.event.correlationId, "request-1");
  assert.equal(parsed.event.booking.reference, "PAY123");
  assert.deepEqual(
    parsed.event.booking.passengers.map(({ name, seat }) => `${name}:${seat}`),
    ["Alice:1A", "Bob:1B"],
  );
  assert.deepEqual(parsed.event.booking.total, TOTAL);
  assert.deepEqual(parsed.event.payment, { id: FIRST_PAYMENT_ID, amount: TOTAL });
});

test("a repeat with the same key and request replays the stored response without charging again (BR-PAY-01)", async () => {
  const runtime = await createRuntime();
  const { booking } = runtime;
  const first = await runtime.payForBooking(booking.id, SCOPE_A, ACTOR_A, request());
  runtime.clock.now = new Date(DEADLINE_MS + 60_000);

  const repeat = await runtime.payForBooking(booking.id, SCOPE_A, ACTOR_A, request());

  assert.equal(first.outcome, "answered");
  assert.deepEqual(repeat, { ...first, replayed: true });
  assert.equal(runtime.gateway.charges.length, 1);
  assert.equal(runtime.auditRecorder.records.length, 1);
});

test("the same key with a different request is idempotency-key-reused and charges nothing (BR-PAY-02)", async () => {
  const runtime = await createRuntime();
  const { booking } = runtime;
  await runtime.payForBooking(booking.id, SCOPE_A, ACTOR_A, request());

  const reused = await runtime.payForBooking(
    booking.id,
    SCOPE_A,
    ACTOR_A,
    request({ fingerprint: "fp-2", paymentMethodToken: "tok_other" }),
  );

  assert.deepEqual(reused, { outcome: "idempotency-key-reused" });
  assert.equal(runtime.gateway.charges.length, 1);
});

test("a declined charge answers 402, records FAILED with the reason, and leaves the booking HELD for a new key", async () => {
  const runtime = await createRuntime();
  const { booking } = runtime;
  runtime.gateway.willCharge({ outcome: "declined", reason: "card_declined" });

  const declined = await runtime.payForBooking(booking.id, SCOPE_A, ACTOR_A, request());

  assert.deepEqual(declined, {
    outcome: "answered",
    replayed: false,
    response: {
      status: 402,
      body: {
        error: { code: "PAYMENT_DECLINED", message: "Payment was declined: card_declined" },
      },
    },
  });
  const payment = await runtime.paymentRepository.findById(FIRST_PAYMENT_ID);
  assert.equal(payment?.status, "FAILED");
  assert.equal(payment?.failureReason, "card_declined");
  assert.equal(runtime.bookingRepository.peek(booking.id)?.status, "HELD");
  assert.deepEqual(seatStatuses(runtime), ["1A:HELD", "1B:HELD", "1C:AVAILABLE"]);
  const [audit] = runtime.auditRecorder.records;
  assert.equal(audit?.action, "PAYMENT_FAILED");
  assert.deepEqual(audit?.target, { type: "payment", id: FIRST_PAYMENT_ID });
  assert.equal(runtime.outboxRepository.entries.length, 0);

  const retried = await runtime.payForBooking(
    booking.id,
    SCOPE_A,
    ACTOR_A,
    request({ idempotencyKey: "key-2" }),
  );
  assert.equal(retried.outcome === "answered" && retried.response.status, 201);
});

test("a charge that lands after the hold lapsed is refunded: 409 BOOKING_NOT_PAYABLE, payment REFUNDED, seats untouched", async () => {
  const runtime = await createRuntime({
    onCharge: () => {
      runtime.clock.now = new Date(DEADLINE_MS);
    },
  });
  const { booking } = runtime;

  const result = await runtime.payForBooking(booking.id, SCOPE_A, ACTOR_A, request());

  assert.equal(result.outcome, "answered");
  assert.deepEqual(result.outcome === "answered" && result.response, {
    status: 409,
    body: {
      error: {
        code: "BOOKING_NOT_PAYABLE",
        message:
          "Booking was cancelled or expired while the payment was processed; the payment was refunded",
      },
    },
  });
  assert.equal(runtime.bookingRepository.peek(booking.id)?.status, "HELD");
  assert.deepEqual(seatStatuses(runtime), ["1A:HELD", "1B:HELD", "1C:AVAILABLE"]);
  const payment = await runtime.paymentRepository.findById(FIRST_PAYMENT_ID);
  assert.equal(payment?.status, "REFUNDED");
  assert.deepEqual(runtime.gateway.refunds, [
    {
      paymentId: FIRST_PAYMENT_ID,
      providerReference: `fake_ch_${FIRST_PAYMENT_ID}`,
      amount: TOTAL,
    },
  ]);
  assert.deepEqual(
    runtime.auditRecorder.records.map(({ action, actor }) => `${action}:${actor.id}`),
    [`PAYMENT_REFUND_PENDING:${FIXTURE_ACCOUNT_A}`, `PAYMENT_REFUNDED:${PAYMENT_REFUND_ACTOR.id}`],
  );
  assert.equal(runtime.outboxRepository.entries.length, 0);
});

test("a charge that lands after the owner cancelled is refunded too", async () => {
  const runtime = await createRuntime({
    onCharge: async () => {
      const cancelled = await runtime.cancelBooking(runtime.booking.id, SCOPE_A, ACTOR_A);
      assert.equal(cancelled.outcome, "cancelled");
    },
  });

  const result = await runtime.payForBooking(runtime.booking.id, SCOPE_A, ACTOR_A, request());

  assert.equal(result.outcome === "answered" && result.response.status, 409);
  assert.equal(runtime.bookingRepository.peek(runtime.booking.id)?.status, "CANCELLED");
  assert.equal((await runtime.paymentRepository.findById(FIRST_PAYMENT_ID))?.status, "REFUNDED");
});

test("a refund the gateway refuses leaves the payment REFUND_PENDING and logs a warning; the answer is still 409", async () => {
  const runtime = await createRuntime({
    onCharge: () => {
      runtime.clock.now = new Date(DEADLINE_MS);
    },
  });
  runtime.gateway.willRefund({ outcome: "failed", reason: "unknown_charge" });

  const result = await runtime.payForBooking(runtime.booking.id, SCOPE_A, ACTOR_A, request());

  assert.equal(result.outcome === "answered" && result.response.status, 409);
  assert.equal((await runtime.paymentRepository.findById(FIRST_PAYMENT_ID))?.status, "REFUND_PENDING");
  assert.deepEqual(runtime.warnings, [
    {
      message: "payment_refund_failed",
      fields: {
        paymentId: FIRST_PAYMENT_ID,
        bookingId: runtime.booking.id,
        reason: "unknown_charge",
      },
    },
  ]);
});

test("an amount other than the booking total is amount-mismatch, charges nothing, and frees the key (BR-PAY-03)", async () => {
  const runtime = await createRuntime();
  const { booking } = runtime;

  const mismatch = await runtime.payForBooking(
    booking.id,
    SCOPE_A,
    ACTOR_A,
    request({ amount: vnd(1_500_000), fingerprint: "fp-wrong-amount" }),
  );

  assert.deepEqual(mismatch, { outcome: "amount-mismatch", total: TOTAL });
  assert.equal(runtime.gateway.charges.length, 0);
  assert.equal(await runtime.paymentRepository.findById(FIRST_PAYMENT_ID), undefined);

  // Not stored: the same key with the corrected body is a new request.
  const corrected = await runtime.payForBooking(booking.id, SCOPE_A, ACTOR_A, request());
  assert.equal(corrected.outcome === "answered" && corrected.response.status, 201);
});

test("a hold with exactly 60 s left cannot start a payment (BR-PAY-07); 1 ms more can", async () => {
  const atMargin = await createRuntime();
  atMargin.clock.now = new Date(DEADLINE_MS - 60_000);

  const refused = await atMargin.payForBooking(atMargin.booking.id, SCOPE_A, ACTOR_A, request());

  assert.deepEqual(refused, {
    outcome: "answered",
    replayed: false,
    response: {
      status: 409,
      body: {
        error: {
          code: "BOOKING_NOT_PAYABLE",
          message: "Booking hold expires in 60 seconds or less; it can no longer be paid",
        },
      },
    },
  });
  assert.equal(atMargin.gateway.charges.length, 0);
  // Stored: the same key replays the refusal.
  assert.deepEqual(
    await atMargin.payForBooking(atMargin.booking.id, SCOPE_A, ACTOR_A, request()),
    { ...refused, replayed: true },
  );

  const justInside = await createRuntime();
  justInside.clock.now = new Date(DEADLINE_MS - 60_001);
  const paid = await justInside.payForBooking(justInside.booking.id, SCOPE_A, ACTOR_A, request());
  assert.equal(paid.outcome === "answered" && paid.response.status, 201);
});

test("a booking that is not HELD, or whose hold lapsed, is 409 BOOKING_NOT_PAYABLE without a charge (BR-PAY-04)", async () => {
  const cancelledRuntime = await createRuntime();
  await cancelledRuntime.cancelBooking(cancelledRuntime.booking.id, SCOPE_A, ACTOR_A);
  const lapsedRuntime = await createRuntime();
  lapsedRuntime.clock.now = new Date(DEADLINE_MS);

  for (const runtime of [cancelledRuntime, lapsedRuntime]) {
    const result = await runtime.payForBooking(runtime.booking.id, SCOPE_A, ACTOR_A, request());

    assert.equal(result.outcome === "answered" && result.response.status, 409);
    assert.deepEqual(result.outcome === "answered" && result.response.body, {
      error: {
        code: "BOOKING_NOT_PAYABLE",
        message: "Booking is not held or its hold has expired",
      },
    });
    assert.equal(runtime.gateway.charges.length, 0);
  }
});

test("another account's booking and a malformed id answer 404, stored with the key (BR-AUTH-02)", async () => {
  const runtime = await createRuntime();
  const actorB: Actor = { accountId: FIXTURE_ACCOUNT_B };

  const foreign = await runtime.payForBooking(runtime.booking.id, SCOPE_B, actorB, request());
  const malformed = await runtime.payForBooking("not-a-uuid", SCOPE_A, ACTOR_A, request());

  for (const result of [foreign, malformed]) {
    assert.deepEqual(result, {
      outcome: "answered",
      replayed: false,
      response: {
        status: 404,
        body: { error: { code: "BOOKING_NOT_FOUND", message: "Booking was not found" } },
      },
    });
  }
  assert.equal(runtime.gateway.charges.length, 0);
  assert.equal(runtime.bookingRepository.peek(runtime.booking.id)?.status, "HELD");
});

test("a second request while the first is charging: same key is in-progress, another key is payment-in-progress", async () => {
  const outcomes: string[] = [];
  const runtime = await createRuntime({
    onCharge: async () => {
      if (outcomes.length > 0) {
        return;
      }
      const sameKey = await runtime.payForBooking(runtime.booking.id, SCOPE_A, ACTOR_A, request());
      const otherKey = await runtime.payForBooking(
        runtime.booking.id,
        SCOPE_A,
        ACTOR_A,
        request({ idempotencyKey: "key-2" }),
      );
      outcomes.push(sameKey.outcome, otherKey.outcome);
    },
  });

  const first = await runtime.payForBooking(runtime.booking.id, SCOPE_A, ACTOR_A, request());

  assert.deepEqual(outcomes, ["idempotency-key-in-progress", "payment-in-progress"]);
  assert.equal(first.outcome === "answered" && first.response.status, 201);
  assert.equal(runtime.gateway.charges.length, 1);
});

test("a gateway error leaves the payment PROCESSING and the key in progress, so a retry cannot charge twice", async () => {
  const runtime = await createRuntime({
    onCharge: () => {
      throw new Error("gateway timeout");
    },
  });

  await assert.rejects(
    runtime.payForBooking(runtime.booking.id, SCOPE_A, ACTOR_A, request()),
    /gateway timeout/,
  );

  assert.equal((await runtime.paymentRepository.findById(FIRST_PAYMENT_ID))?.status, "PROCESSING");
  assert.deepEqual(
    await runtime.payForBooking(runtime.booking.id, SCOPE_A, ACTOR_A, request()),
    { outcome: "idempotency-key-in-progress" },
  );
  assert.deepEqual(
    await runtime.payForBooking(
      runtime.booking.id,
      SCOPE_A,
      ACTOR_A,
      request({ idempotencyKey: "key-2" }),
    ),
    { outcome: "payment-in-progress" },
  );
  assert.equal(runtime.gateway.charges.length, 1);
});

test("a valid hold can still be paid after sales close (BR-PAY-06)", async () => {
  // Bookable at HELD_AT (departure − 1 h is 1 minute later); CLOSED by the
  // time the payment runs, two minutes after the hold.
  const departure = HELD_AT.getTime() + 61 * 60_000;
  const runtime = await createRuntime({
    flight: {
      departureAt: new Date(departure).toISOString(),
      arrivalAt: new Date(departure + 2 * 60 * 60_000).toISOString(),
    },
  });
  runtime.clock.now = new Date(HELD_AT.getTime() + 2 * 60_000);

  const result = await runtime.payForBooking(runtime.booking.id, SCOPE_A, ACTOR_A, request());

  assert.equal(result.outcome === "answered" && result.response.status, 201);
  assert.equal(runtime.bookingRepository.peek(runtime.booking.id)?.status, "CONFIRMED");
});
