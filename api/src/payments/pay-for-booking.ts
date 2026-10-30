import type { AuditActor, AuditRecorder } from "../audit/audit-recorder.js";
import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
} from "../bookings/booking-repository.js";
import {
  PAY_BOOKING_OPERATION,
  type IdempotencyRepository,
  type IdempotencyScope,
  type StoredResponse,
} from "../idempotency/idempotency-repository.js";
import type { Money } from "../money/money.js";
import type { Logger } from "../observability/logger.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor } from "../types.js";
import type { PaymentGateway } from "./payment-gateway.js";
import type {
  NewPayment,
  Payment,
  PaymentRepository,
} from "./payment-repository.js";
import { toStoredResponse, type PaymentDecision } from "./payment-response.js";
import { createSettlePayment } from "./settle-payment.js";

/** BR-PAY-07: a payment starts only while the hold has more than this left. */
export const PAYMENT_START_MARGIN_MS = 60_000;

/**
 * How long after the gateway timeout reconciliation may take a PROCESSING
 * payment: room for the live request's phase 3 to commit first (Decision 15).
 */
export const PAYMENT_RECONCILIATION_MARGIN_MS = 30_000;

/**
 * The request as the route validated it. `fingerprint` covers method, path
 * and body (requestFingerprint), so the use case never sees HTTP.
 */
export type PaymentRequest = Readonly<{
  idempotencyKey: string;
  fingerprint: string;
  paymentMethodToken: string;
  amount: Money;
}>;

/**
 * - answered: a final outcome, stored with the key; `replayed` when it was
 *   stored by an earlier request with the same key and body (BR-PAY-01).
 * The others are not stored — the client may retry with the same key:
 * - idempotency-key-reused: same key, different request (BR-PAY-02).
 * - idempotency-key-in-progress: the first request with this key has not
 *   finished.
 * - amount-mismatch: the amount is not the booking total (BR-PAY-03).
 * - payment-in-progress: another key is paying this booking right now.
 * - processing: the gateway's answer is unknown (BR-PAY-08). Nothing is
 *   stored and the key stays in progress until reconciliation finishes the
 *   payment; the same key then gets the final answer.
 */
export type PayForBookingResult =
  | Readonly<{ outcome: "answered"; response: StoredResponse; replayed: boolean }>
  | Readonly<{ outcome: "idempotency-key-reused" }>
  | Readonly<{ outcome: "idempotency-key-in-progress" }>
  | Readonly<{ outcome: "amount-mismatch"; total: Money }>
  | Readonly<{ outcome: "payment-in-progress" }>
  | Readonly<{ outcome: "processing"; payment: Payment }>;

/**
 * `scope` decides which bookings the caller can reach (BR-AUTH-02); the
 * key belongs to `actor`'s account (Decision 14).
 */
export type PayForBooking = (
  bookingId: string,
  scope: BookingAccessScope,
  actor: Actor,
  request: PaymentRequest,
) => Promise<PayForBookingResult>;

type PayForBookingDependencies = {
  bookingRepository: BookingRepository;
  paymentRepository: PaymentRepository;
  idempotencyRepository: IdempotencyRepository;
  paymentGateway: PaymentGateway;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  logger: Logger;
  generatePaymentId: () => string;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
  /** Gateway timeout + PAYMENT_RECONCILIATION_MARGIN_MS (Decision 15). */
  reconcileAfterMs: number;
};

type Started = Readonly<{ outcome: "started"; payment: Payment }>;

function canStartPayment(booking: Booking, now: Date): boolean {
  return (
    booking.status === "HELD" &&
    booking.holdExpiresAt !== null &&
    new Date(booking.holdExpiresAt).getTime() > now.getTime() + PAYMENT_START_MARGIN_MS
  );
}

function isSameMoney(left: Money, right: Money): boolean {
  return left.amount === right.amount && left.currency === right.currency;
}

/**
 * US-PAY-01 in three phases around the gateway (Decision 14, ADR-009):
 *
 * 1. Transaction: claim the key; check the booking (scope, HELD, BR-PAY-07
 *    margin, BR-PAY-03 amount); record a PROCESSING payment and link it to
 *    the key.
 * 2. No transaction: charge. Nothing is locked while the gateway works.
 * 3. Transaction: record the outcome and complete the key with its
 *    response — SettlePayment, the same code reconciliation runs
 *    (Decision 15). On a charge, confirm the hold at phase 3's own `now`; if
 *    the booking was cancelled or expired meanwhile, mark REFUND_PENDING —
 *    the reconciliation job refunds it.
 *
 * An unknown outcome (BR-PAY-08) and a gateway call that throws both leave
 * the payment PROCESSING and the key in progress: the charge may have
 * happened, so a retry must not start another. Reconciliation finishes the
 * payment once its next_attempt_at, set in phase 1, has passed.
 */
export function createPayForBooking(
  dependencies: PayForBookingDependencies,
): PayForBooking {
  const {
    bookingRepository,
    paymentRepository,
    idempotencyRepository,
    paymentGateway,
    transactionRunner,
    logger,
    generatePaymentId,
    getCurrentTime,
    reconcileAfterMs,
  } = dependencies;
  // Audit, outbox, ids and request id are phase 3's alone.
  const settle = createSettlePayment(dependencies);

  function answered(response: StoredResponse): PayForBookingResult {
    return { outcome: "answered", response, replayed: false };
  }

  /** Store a final outcome with the key, inside the caller's transaction. */
  async function answer(
    keyScope: IdempotencyScope,
    key: string,
    decision: PaymentDecision,
    now: Date,
  ): Promise<PayForBookingResult> {
    const response = toStoredResponse(decision);
    await idempotencyRepository.complete(keyScope, key, response, now);
    return { outcome: "answered", response, replayed: false };
  }

  async function startPayment(
    bookingId: string,
    scope: BookingAccessScope,
    actor: Actor,
    keyScope: IdempotencyScope,
    request: PaymentRequest,
  ): Promise<PayForBookingResult | Started> {
    const { idempotencyKey: key, fingerprint } = request;
    const now = getCurrentTime();
    const claim = await idempotencyRepository.claim(keyScope, key, fingerprint, now);

    if (claim.outcome !== "claimed") {
      if (claim.fingerprint !== fingerprint) {
        return { outcome: "idempotency-key-reused" };
      }
      return claim.outcome === "completed"
        ? { outcome: "answered", response: claim.response, replayed: true }
        : { outcome: "idempotency-key-in-progress" };
    }

    const booking = isUuid(bookingId)
      ? await bookingRepository.findById(bookingId, scope)
      : undefined;

    if (booking === undefined) {
      return answer(keyScope, key, { outcome: "not-found" }, now);
    }

    if (!canStartPayment(booking, now)) {
      const reason =
        booking.status === "HELD" &&
        booking.holdExpiresAt !== null &&
        new Date(booking.holdExpiresAt).getTime() > now.getTime()
          ? "under-margin"
          : "not-held";
      return answer(keyScope, key, { outcome: "not-payable", reason }, now);
    }

    if (!isSameMoney(request.amount, booking.total)) {
      await idempotencyRepository.release(keyScope, key);
      return { outcome: "amount-mismatch", total: booking.total };
    }

    const newPayment: NewPayment = {
      id: generatePaymentId(),
      bookingId: booking.id,
      accountId: actor.accountId,
      amount: booking.total,
      paymentMethodToken: request.paymentMethodToken,
      nextAttemptAt: new Date(now.getTime() + reconcileAfterMs).toISOString(),
      createdAt: now.toISOString(),
    };

    const started = await paymentRepository.start(newPayment);
    if (started.outcome === "payment-in-progress") {
      await idempotencyRepository.release(keyScope, key);
      return { outcome: "payment-in-progress" };
    }

    const payment: Payment = {
      ...newPayment,
      status: "PROCESSING",
      providerReference: null,
      failureReason: null,
      attempts: 0,
      updatedAt: newPayment.createdAt,
    };
    await idempotencyRepository.attachPayment(keyScope, key, payment.id);
    return { outcome: "started", payment };
  }

  return async (bookingId, scope, actor, request) => {
    const keyScope: IdempotencyScope = {
      accountId: actor.accountId,
      operation: PAY_BOOKING_OPERATION,
    };

    const phase1 = await transactionRunner.run(() =>
      startPayment(bookingId, scope, actor, keyScope, request),
    );
    if (phase1.outcome !== "started") {
      return phase1;
    }

    const { payment } = phase1;
    const charge = await paymentGateway.charge({
      paymentId: payment.id,
      amount: payment.amount,
      paymentMethodToken: request.paymentMethodToken,
    });

    const payer: AuditActor = { type: "account", id: actor.accountId };
    if (charge.outcome === "declined") {
      return answered(await settle.declined(payment, charge.reason, payer));
    }
    if (charge.outcome === "unknown") {
      logger.warn("payment_outcome_unknown", {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        reason: charge.reason,
      });
      return { outcome: "processing", payment };
    }

    return answered(await settle.charged(payment, charge.providerReference, payer));
  };
}
