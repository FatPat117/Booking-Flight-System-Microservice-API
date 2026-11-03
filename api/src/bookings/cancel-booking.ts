import type { BookingCancelledEvent } from "@booking-flight-system/contracts";

import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { Money } from "../money/money.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { PaymentRepository } from "../payments/payment-repository.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor } from "../types.js";
import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
} from "./booking-repository.js";

export const BOOKING_CANCELLED_QUEUE = "booking-cancelled";

/** A paid booking's refund, started by the cancel and made by the job. */
export type StartedRefund = Readonly<{
  paymentId: string;
  amount: Money;
}>;

export type CancelBookingResult =
  | { outcome: "cancelled"; booking: Booking; refund: StartedRefund | null }
  | { outcome: "already-cancelled" }
  | { outcome: "expired" }
  | { outcome: "cancellation-window-closed"; cancellableUntil: string }
  | { outcome: "not-found" };

/**
 * `scope` decides which bookings the caller can reach (out of scope →
 * not-found, BR-AUTH-02); `actor` is who gets recorded in the audit log.
 */
export type CancelBooking = (
  bookingId: string,
  scope: BookingAccessScope,
  actor: Actor,
) => Promise<CancelBookingResult>;

type CancelBookingDependencies = {
  bookingRepository: BookingRepository;
  paymentRepository: PaymentRepository;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * Cancel a HELD or CONFIRMED booking and release all its seats. A HELD one
 * is limited only by its own hold: once lapsed (BR-BOOK-10) it is expired,
 * not cancelled — `expired`, nothing written, the expiry job ends it
 * (Decision 12). A CONFIRMED one only more than 24 h before departure
 * (BR-BOOK-06); its payment is refunded in full (Decision 16).
 *
 * One transaction, in the lock order of the table in domain-model: the
 * booking and its seats (BookingRepository.cancel checks both deadlines in
 * its own statement and releases the seats only when it wins), then the
 * payment — SUCCEEDED → REFUND_PENDING, due now. The refund itself is the
 * reconciliation job's (Decision 15): this never calls the gateway
 * (ADR-009), and the booking is never cancelled with its money still taken,
 * nor the money refunded for a booking that stands.
 *
 * `now` is read once and used for the decisions and the audit/event time.
 */
export function createCancelBooking(
  dependencies: CancelBookingDependencies,
): CancelBooking {
  const {
    bookingRepository,
    paymentRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId,
    generateOutboxId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (
    bookingId: string,
    scope: BookingAccessScope,
    actor: Actor,
  ): Promise<CancelBookingResult> => {
    if (!isUuid(bookingId)) {
      return { outcome: "not-found" };
    }

    const now = getCurrentTime();

    return transactionRunner.run(async () => {
      const cancelResult = await bookingRepository.cancel(bookingId, scope, now);

      if (cancelResult.outcome !== "cancelled") {
        return cancelResult;
      }

      const { flightId, reference, seats } = cancelResult;
      const payment = await paymentRepository.markRefundPendingForCancelledBooking(
        bookingId,
        now,
      );
      const refund: StartedRefund | null =
        payment === undefined ? null : { paymentId: payment.id, amount: payment.amount };

      const occurredAt = now.toISOString();
      const requestId = getRequestId();
      const eventId = generateOutboxId();
      const correlationId = resolveCorrelationId(requestId, eventId);
      const auditActor = { type: "account", id: actor.accountId } as const;

      await auditRecorder.record({
        id: generateAuditId(),
        action: "BOOKING_CANCELLED",
        actor: auditActor,
        target: {
          type: "booking",
          id: bookingId,
        },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt,
        metadata: {
          flightId,
          correlationId,
          ...(refund === null ? {} : { refundPaymentId: refund.paymentId }),
        },
      });

      if (payment !== undefined) {
        await auditRecorder.record({
          id: generateAuditId(),
          action: "PAYMENT_REFUND_PENDING",
          actor: auditActor,
          target: { type: "payment", id: payment.id },
          ...(requestId === undefined ? {} : { requestId }),
          occurredAt,
          metadata: {
            bookingId,
            amountVnd: payment.amount.amount,
            providerReference: payment.providerReference,
            reason: "booking-cancelled",
          },
        });
      }

      const payload: BookingCancelledEvent = {
        eventId,
        correlationId,
        type: "booking.cancelled",
        occurredAt,
        booking: {
          id: bookingId,
          reference,
          flightId,
          seats: [...seats],
        },
        refund:
          refund === null
            ? null
            : {
                paymentId: refund.paymentId,
                amount: { amount: refund.amount.amount, currency: refund.amount.currency },
              },
      };
      await outboxRepository.enqueue({
        id: eventId,
        eventType: BOOKING_CANCELLED_QUEUE,
        payload,
        createdAt: occurredAt,
      });

      const booking = await bookingRepository.findById(bookingId, scope);
      if (booking === undefined) {
        // Cancelled inside this transaction and in scope: a read that misses
        // it is a bug, not an outcome.
        throw new Error(`Cancelled booking ${bookingId} could not be read back`);
      }

      return { outcome: "cancelled", booking, refund } as const;
    });
  };
}
