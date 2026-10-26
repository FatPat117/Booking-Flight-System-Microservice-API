import type { BookingConfirmedEvent } from "@booking-flight-system/contracts";
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
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor } from "../types.js";
import type { PaymentGateway } from "./payment-gateway.js";
import type { Payment, PaymentRepository } from "./payment-repository.js";
import { toStoredResponse, type PaymentDecision } from "./payment-response.js";

export const BOOKING_CONFIRMED_QUEUE = "booking-confirmed";

/** BR-PAY-07: a payment starts only while the hold has more than this left. */
export const PAYMENT_START_MARGIN_MS = 60_000;

/** Who refunds a charge whose booking was lost: no account, the system. */
export const PAYMENT_REFUND_ACTOR: AuditActor = {
  type: "system",
  id: "payment-refund",
};

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
 */
export type PayForBookingResult =
  | Readonly<{ outcome: "answered"; response: StoredResponse; replayed: boolean }>
  | Readonly<{ outcome: "idempotency-key-reused" }>
  | Readonly<{ outcome: "idempotency-key-in-progress" }>
  | Readonly<{ outcome: "amount-mismatch"; total: Money }>
  | Readonly<{ outcome: "payment-in-progress" }>;

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
};

type Started = Readonly<{ outcome: "started"; booking: Booking; payment: Payment }>;

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
 *    response. On a charge, confirm the hold at phase 3's own `now`; if the
 *    booking was cancelled or expired meanwhile, mark REFUND_PENDING, commit,
 *    and only then refund (and record REFUNDED in a short transaction).
 *
 * A gateway call that throws leaves the payment PROCESSING and the key in
 * progress: the charge may have happened, so a retry must not start another
 * (reconciliation, 49C). The error reaches the caller.
 */
export function createPayForBooking(
  dependencies: PayForBookingDependencies,
): PayForBooking {
  const {
    bookingRepository,
    paymentRepository,
    idempotencyRepository,
    paymentGateway,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    logger,
    generatePaymentId,
    generateAuditId,
    generateOutboxId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

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

    const createdAt = now.toISOString();
    const payment: Payment = {
      id: generatePaymentId(),
      bookingId: booking.id,
      accountId: actor.accountId,
      amount: booking.total,
      status: "PROCESSING",
      providerReference: null,
      failureReason: null,
      createdAt,
      updatedAt: createdAt,
    };

    const started = await paymentRepository.start(payment);
    if (started.outcome === "payment-in-progress") {
      await idempotencyRepository.release(keyScope, key);
      return { outcome: "payment-in-progress" };
    }

    await idempotencyRepository.attachPayment(keyScope, key, payment.id);
    return { outcome: "started", booking, payment };
  }

  async function recordDecline(
    actor: Actor,
    keyScope: IdempotencyScope,
    key: string,
    payment: Payment,
    reason: string,
  ): Promise<PayForBookingResult> {
    return transactionRunner.run(async () => {
      const now = getCurrentTime();
      await paymentRepository.markFailed(payment.id, reason, now);

      const requestId = getRequestId();
      await auditRecorder.record({
        id: generateAuditId(),
        action: "PAYMENT_FAILED",
        actor: { type: "account", id: actor.accountId },
        target: { type: "payment", id: payment.id },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt: now.toISOString(),
        metadata: {
          bookingId: payment.bookingId,
          amountVnd: payment.amount.amount,
          reason,
        },
      });

      const failed: Payment = {
        ...payment,
        status: "FAILED",
        failureReason: reason,
        updatedAt: now.toISOString(),
      };
      return answer(keyScope, key, { outcome: "declined", payment: failed }, now);
    });
  }

  /**
   * Phase 3 after a charge. `refund` is set when the booking was lost: the
   * caller refunds after this transaction has committed REFUND_PENDING.
   */
  async function recordCharge(
    booking: Booking,
    scope: BookingAccessScope,
    actor: Actor,
    keyScope: IdempotencyScope,
    key: string,
    payment: Payment,
    providerReference: string,
  ): Promise<{ result: PayForBookingResult; refund: boolean }> {
    return transactionRunner.run(async () => {
      const now = getCurrentTime();
      const occurredAt = now.toISOString();
      const requestId = getRequestId();
      const confirmation = await bookingRepository.confirmHold(booking.id, scope, now);

      if (confirmation.outcome === "not-payable") {
        await paymentRepository.markRefundPending(payment.id, providerReference, now);
        await auditRecorder.record({
          id: generateAuditId(),
          action: "PAYMENT_REFUND_PENDING",
          actor: { type: "account", id: actor.accountId },
          target: { type: "payment", id: payment.id },
          ...(requestId === undefined ? {} : { requestId }),
          occurredAt,
          metadata: {
            bookingId: booking.id,
            amountVnd: payment.amount.amount,
            providerReference,
          },
        });
        const result = await answer(
          keyScope,
          key,
          { outcome: "not-payable", reason: "refunded" },
          now,
        );
        return { result, refund: true };
      }

      const confirmed = confirmation.booking;
      await paymentRepository.markSucceeded(payment.id, providerReference, now);

      const eventId = generateOutboxId();
      const correlationId = resolveCorrelationId(requestId, eventId);

      await auditRecorder.record({
        id: generateAuditId(),
        action: "BOOKING_CONFIRMED",
        actor: { type: "account", id: actor.accountId },
        target: { type: "booking", id: confirmed.id },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt,
        metadata: {
          flightId: confirmed.flightId,
          reference: confirmed.reference,
          paymentId: payment.id,
          amountVnd: payment.amount.amount,
          correlationId,
        },
      });

      const payload: BookingConfirmedEvent = {
        eventId,
        correlationId,
        type: "booking.confirmed",
        occurredAt,
        booking: {
          id: confirmed.id,
          reference: confirmed.reference,
          flightId: confirmed.flightId,
          // Field by field: the event is a contract, not the domain type.
          passengers: confirmed.passengers.map(({ name, seat, fareClass, price }) => {
            if (seat === null || fareClass === null || price === null) {
              // Only legacy cancelled bookings lack these; they are never HELD.
              throw new Error(`Confirmed booking ${confirmed.id} has a passenger without a seat`);
            }
            return {
              name,
              seat,
              fareClass,
              price: { amount: price.amount, currency: price.currency },
            };
          }),
          total: { amount: confirmed.total.amount, currency: confirmed.total.currency },
        },
        payment: {
          id: payment.id,
          amount: { amount: payment.amount.amount, currency: payment.amount.currency },
        },
      };

      await outboxRepository.enqueue({
        id: eventId,
        eventType: BOOKING_CONFIRMED_QUEUE,
        payload,
        createdAt: occurredAt,
      });

      const succeeded: Payment = {
        ...payment,
        status: "SUCCEEDED",
        providerReference,
        updatedAt: occurredAt,
      };
      const result = await answer(
        keyScope,
        key,
        { outcome: "confirmed", booking: confirmed, payment: succeeded },
        now,
      );
      return { result, refund: false };
    });
  }

  /**
   * After REFUND_PENDING has committed. The customer's answer is already
   * stored, so a failure here is logged, not thrown: the payment stays
   * REFUND_PENDING for reconciliation (49C).
   */
  async function refundCharge(payment: Payment, providerReference: string): Promise<void> {
    try {
      const refund = await paymentGateway.refund({
        paymentId: payment.id,
        providerReference,
        amount: payment.amount,
      });

      if (refund.outcome === "failed") {
        logger.warn("payment_refund_failed", {
          paymentId: payment.id,
          bookingId: payment.bookingId,
          reason: refund.reason,
        });
        return;
      }

      await transactionRunner.run(async () => {
        const now = getCurrentTime();
        await paymentRepository.markRefunded(payment.id, now);
        await auditRecorder.record({
          id: generateAuditId(),
          action: "PAYMENT_REFUNDED",
          actor: PAYMENT_REFUND_ACTOR,
          target: { type: "payment", id: payment.id },
          occurredAt: now.toISOString(),
          metadata: {
            bookingId: payment.bookingId,
            amountVnd: payment.amount.amount,
            providerReference,
          },
        });
      });
    } catch (error) {
      logger.warn("payment_refund_failed", {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return async (bookingId, scope, actor, request) => {
    const keyScope: IdempotencyScope = {
      accountId: actor.accountId,
      operation: PAY_BOOKING_OPERATION,
    };
    const key = request.idempotencyKey;

    const phase1 = await transactionRunner.run(() =>
      startPayment(bookingId, scope, actor, keyScope, request),
    );
    if (phase1.outcome !== "started") {
      return phase1;
    }

    const { booking, payment } = phase1;
    const charge = await paymentGateway.charge({
      paymentId: payment.id,
      amount: payment.amount,
      paymentMethodToken: request.paymentMethodToken,
    });

    if (charge.outcome === "declined") {
      return recordDecline(actor, keyScope, key, payment, charge.reason);
    }

    const { result, refund } = await recordCharge(
      booking,
      scope,
      actor,
      keyScope,
      key,
      payment,
      charge.providerReference,
    );
    if (refund) {
      await refundCharge(payment, charge.providerReference);
    }
    return result;
  };
}
