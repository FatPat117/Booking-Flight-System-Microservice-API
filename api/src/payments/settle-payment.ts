import type { BookingConfirmedEvent } from "@booking-flight-system/contracts";
import type { AuditActor, AuditRecorder } from "../audit/audit-recorder.js";
import type { BookingRepository } from "../bookings/booking-repository.js";
import type {
  IdempotencyRepository,
  StoredResponse,
} from "../idempotency/idempotency-repository.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { Payment, PaymentRepository } from "./payment-repository.js";
import { toStoredResponse, type PaymentDecision } from "./payment-response.js";

export const BOOKING_CONFIRMED_QUEUE = "booking-confirmed";

/**
 * Phase 3 of a payment (Decision 14): record the gateway's definite answer
 * and the customer's final response together. Each call is one short
 * transaction, and returns the response it stored with the key.
 *
 * Shared by the paying request and the reconciliation job (Decision 15), so
 * the two can never disagree on what a charge or a decline means. They
 * differ only in `actor`: the paying account, or the system.
 */
export type SettlePayment = Readonly<{
  /**
   * The gateway charged. Confirm the hold at this transaction's own `now`
   * (BR-BOOK-10); if the booking was cancelled or expired meanwhile, record
   * REFUND_PENDING instead, which the reconciliation job refunds.
   */
  charged(payment: Payment, providerReference: string, actor: AuditActor): Promise<StoredResponse>;
  /** The gateway declined: FAILED, booking stays HELD. */
  declined(payment: Payment, reason: string, actor: AuditActor): Promise<StoredResponse>;
}>;

type SettlePaymentDependencies = {
  bookingRepository: BookingRepository;
  paymentRepository: PaymentRepository;
  idempotencyRepository: IdempotencyRepository;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * Every transition is conditional on PROCESSING: if the request and the job
 * both reach phase 3 for one payment, the second throws and its transaction
 * — booking confirmation included — rolls back.
 *
 * The key is completed by the payment it started, not by its scope and key,
 * because the job knows only the payment. The booking is confirmed in the
 * payer's own scope: only the owner can pay (BR-AUTH-03), so it is the same
 * scope the request used.
 */
export function createSettlePayment(dependencies: SettlePaymentDependencies): SettlePayment {
  const {
    bookingRepository,
    paymentRepository,
    idempotencyRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId,
    generateOutboxId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  /** Store the final response with the key, inside the caller's transaction. */
  async function answer(payment: Payment, decision: PaymentDecision, now: Date) {
    const response = toStoredResponse(decision);
    await idempotencyRepository.completeForPayment(payment.id, response, now);
    return response;
  }

  return {
    async declined(payment, reason, actor) {
      return transactionRunner.run(async () => {
        const now = getCurrentTime();
        await paymentRepository.markFailed(payment.id, reason, now);

        const requestId = getRequestId();
        await auditRecorder.record({
          id: generateAuditId(),
          action: "PAYMENT_FAILED",
          actor,
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
          paymentMethodToken: null,
          nextAttemptAt: null,
          updatedAt: now.toISOString(),
        };
        return answer(payment, { outcome: "declined", payment: failed }, now);
      });
    },

    async charged(payment, providerReference, actor) {
      return transactionRunner.run(async () => {
        const now = getCurrentTime();
        const occurredAt = now.toISOString();
        const requestId = getRequestId();
        const confirmation = await bookingRepository.confirmHold(
          payment.bookingId,
          { kind: "owner", accountId: payment.accountId },
          now,
        );

        if (confirmation.outcome === "not-payable") {
          await paymentRepository.markRefundPending(payment.id, providerReference, now);
          await auditRecorder.record({
            id: generateAuditId(),
            action: "PAYMENT_REFUND_PENDING",
            actor,
            target: { type: "payment", id: payment.id },
            ...(requestId === undefined ? {} : { requestId }),
            occurredAt,
            metadata: {
              bookingId: payment.bookingId,
              amountVnd: payment.amount.amount,
              providerReference,
            },
          });
          return answer(payment, { outcome: "not-payable", reason: "refunded" }, now);
        }

        const confirmed = confirmation.booking;
        await paymentRepository.markSucceeded(payment.id, providerReference, now);

        const eventId = generateOutboxId();
        const correlationId = resolveCorrelationId(requestId, eventId);

        await auditRecorder.record({
          id: generateAuditId(),
          action: "BOOKING_CONFIRMED",
          actor,
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
          paymentMethodToken: null,
          nextAttemptAt: null,
          updatedAt: occurredAt,
        };
        return answer(payment, { outcome: "confirmed", booking: confirmed, payment: succeeded }, now);
      });
    },
  };
}
