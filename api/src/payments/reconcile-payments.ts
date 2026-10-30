import type { AuditActor, AuditRecorder } from "../audit/audit-recorder.js";
import type { BookingRepository } from "../bookings/booking-repository.js";
import type { IdempotencyRepository } from "../idempotency/idempotency-repository.js";
import type { Logger } from "../observability/logger.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { PaymentGateway, RefundResult } from "./payment-gateway.js";
import type { Payment, PaymentRepository } from "./payment-repository.js";
import { createSettlePayment } from "./settle-payment.js";

/** Who finishes a payment the request could not: the job (Decision 15). */
export const PAYMENT_RECONCILIATION_ACTOR: AuditActor = {
  type: "system",
  id: "payment-reconciliation",
};

/** BR-PAY-09: the fifth failed refund attempt is the last. */
export const MAX_REFUND_ATTEMPTS = 5;

const MINUTE_MS = 60_000;
/** An unknown charge is retried until it is known, but at least this often. */
const MAX_CHARGE_RETRY_DELAY_MS = 10 * MINUTE_MS;
const WARN_UNKNOWN_FROM_ATTEMPT = 3;

/** 1, 2, 4, 8 … minutes after the given (1-based) attempt. */
function retryDelayMs(attempt: number): number {
  return MINUTE_MS * 2 ** (attempt - 1);
}

type Reconciled = "settled" | "refunded" | "refund-failed" | "retry-later" | "failed";

/**
 * - settled: a PROCESSING payment got a definite answer (confirmed, declined
 *   or left for refund).
 * - refunded / refundFailed: REFUND_PENDING payments finished either way.
 * - retryLater: still unknown, or a refund to try again; rescheduled.
 * - failed: threw (e.g. the request finished it first); left as it was, the
 *   lease brings it back.
 * - exhausted: stopped at `maxBatches` with the last batch full.
 */
export type ReconcilePaymentsResult = Readonly<{
  settled: number;
  refunded: number;
  refundFailed: number;
  retryLater: number;
  failed: number;
  batches: number;
  exhausted: boolean;
}>;

export type ReconcilePayments = () => Promise<ReconcilePaymentsResult>;

type ReconcilePaymentsDependencies = {
  bookingRepository: BookingRepository;
  paymentRepository: PaymentRepository;
  idempotencyRepository: IdempotencyRepository;
  paymentGateway: PaymentGateway;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  logger: Logger;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
  /** Gateway timeout + PAYMENT_RECONCILIATION_MARGIN_MS: the lease. */
  leaseMs: number;
  batchSize: number;
  maxBatches: number;
};

/**
 * One run of the reconciliation job (Decision 15, ADR-010).
 *
 * Per batch: claim due payments in a short transaction (SKIP LOCKED, lease,
 * attempt counted) and commit; call the gateway with no transaction open
 * (ADR-009); record each answer in its own short transaction.
 *
 * - PROCESSING: charge again with the same payment id. A definite answer
 *   goes through SettlePayment, the request's own phase 3. Unknown again:
 *   retry later, never FAILED (BR-PAY-08).
 * - REFUND_PENDING: refund. Refunded: REFUNDED. Failed or unknown: retry
 *   after 1, 2, 4, 8 minutes; not retryable, or the fifth attempt:
 *   REFUND_FAILED, reported for a person (BR-PAY-09).
 *
 * A batch's gateway calls run concurrently, so the whole batch finishes
 * within one gateway timeout — inside its lease. One at a time, a batch of
 * 20 could take 20 timeouts and outlive the lease of its last payments.
 * A payment that throws is logged and skipped; the others go on.
 */
export function createReconcilePayments(
  dependencies: ReconcilePaymentsDependencies,
): ReconcilePayments {
  const {
    paymentRepository,
    paymentGateway,
    auditRecorder,
    transactionRunner,
    logger,
    generateAuditId,
    getCurrentTime,
    leaseMs,
    batchSize,
    maxBatches,
  } = dependencies;
  const settle = createSettlePayment(dependencies);
  const actor = PAYMENT_RECONCILIATION_ACTOR;

  async function retryLater(payment: Payment, delayMs: number): Promise<Reconciled> {
    const nextAttemptAt = new Date(getCurrentTime().getTime() + delayMs);
    await paymentRepository.reschedule(
      payment.id,
      payment.status === "PROCESSING" ? "PROCESSING" : "REFUND_PENDING",
      nextAttemptAt,
    );
    return "retry-later";
  }

  async function reconcileCharge(payment: Payment): Promise<Reconciled> {
    if (payment.paymentMethodToken === null) {
      // CHK_payments_token makes this impossible for a PROCESSING row.
      throw new Error(`PROCESSING payment ${payment.id} has no payment method token`);
    }

    const charge = await paymentGateway.charge({
      paymentId: payment.id,
      amount: payment.amount,
      paymentMethodToken: payment.paymentMethodToken,
    });

    if (charge.outcome === "succeeded") {
      await settle.charged(payment, charge.providerReference, actor);
      return "settled";
    }
    if (charge.outcome === "declined") {
      await settle.declined(payment, charge.reason, actor);
      return "settled";
    }

    if (payment.attempts >= WARN_UNKNOWN_FROM_ATTEMPT) {
      logger.warn("payment_outcome_still_unknown", {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        attempts: payment.attempts,
        reason: charge.reason,
      });
    }
    return retryLater(
      payment,
      Math.min(retryDelayMs(payment.attempts), MAX_CHARGE_RETRY_DELAY_MS),
    );
  }

  async function recordRefund(
    payment: Payment,
    action: "PAYMENT_REFUNDED" | "PAYMENT_REFUND_FAILED",
    reason?: string,
  ): Promise<void> {
    await transactionRunner.run(async () => {
      const now = getCurrentTime();
      if (action === "PAYMENT_REFUNDED") {
        await paymentRepository.markRefunded(payment.id, now);
      } else {
        await paymentRepository.markRefundFailed(payment.id, reason ?? "unknown", now);
      }
      await auditRecorder.record({
        id: generateAuditId(),
        action,
        actor,
        target: { type: "payment", id: payment.id },
        occurredAt: now.toISOString(),
        metadata: {
          bookingId: payment.bookingId,
          amountVnd: payment.amount.amount,
          providerReference: payment.providerReference,
          attempts: payment.attempts,
          ...(reason === undefined ? {} : { reason }),
        },
      });
    });
  }

  async function reconcileRefund(payment: Payment): Promise<Reconciled> {
    if (payment.providerReference === null) {
      // CHK_payments_provider_reference makes this impossible for REFUND_PENDING.
      throw new Error(`REFUND_PENDING payment ${payment.id} has no provider reference`);
    }

    const refund: RefundResult = await paymentGateway.refund({
      paymentId: payment.id,
      providerReference: payment.providerReference,
      amount: payment.amount,
    });

    if (refund.outcome === "refunded") {
      await recordRefund(payment, "PAYMENT_REFUNDED");
      return "refunded";
    }

    const retryable = refund.outcome === "unknown" || refund.retryable;
    if (!retryable || payment.attempts >= MAX_REFUND_ATTEMPTS) {
      await recordRefund(payment, "PAYMENT_REFUND_FAILED", refund.reason);
      logger.error("payment_refund_needs_attention", {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        attempts: payment.attempts,
        reason: refund.reason,
      });
      return "refund-failed";
    }

    logger.warn("payment_refund_retry", {
      paymentId: payment.id,
      bookingId: payment.bookingId,
      attempts: payment.attempts,
      reason: refund.reason,
    });
    return retryLater(payment, retryDelayMs(payment.attempts));
  }

  async function reconcile(payment: Payment): Promise<Reconciled> {
    try {
      return payment.status === "PROCESSING"
        ? await reconcileCharge(payment)
        : await reconcileRefund(payment);
    } catch (error) {
      logger.error("payment_reconciliation_failed", {
        paymentId: payment.id,
        status: payment.status,
        error: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }
  }

  return async () => {
    const tally: Record<Reconciled, number> = {
      settled: 0,
      refunded: 0,
      "refund-failed": 0,
      "retry-later": 0,
      failed: 0,
    };
    const result = (batches: number, exhausted: boolean): ReconcilePaymentsResult => ({
      settled: tally.settled,
      refunded: tally.refunded,
      refundFailed: tally["refund-failed"],
      retryLater: tally["retry-later"],
      failed: tally.failed,
      batches,
      exhausted,
    });

    for (let batches = 1; batches <= maxBatches; batches += 1) {
      const claimed = await transactionRunner.run(() =>
        paymentRepository.claimDue(getCurrentTime(), leaseMs, batchSize),
      );

      for (const outcome of await Promise.all(claimed.map(reconcile))) {
        tally[outcome] += 1;
      }

      if (claimed.length < batchSize) {
        return result(batches, false);
      }
    }

    return result(maxBatches, true);
  };
}
