import type { BookingCancelledEvent } from "@booking-flight-system/contracts";

import type { AuditActor, AuditRecorder } from "../audit/audit-recorder.js";
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
  CancellationReason,
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

/**
 * The cancel core (Decision 18): everything one cancellation writes, inside
 * the caller's transaction. The owner's cancel and the flight cancellation
 * cascade both run it; they differ only in what they pass:
 * - `reason` decides the rule — CUSTOMER applies BR-BOOK-06's 24 h window,
 *   AIRLINE does not and needs the flight CANCELLED (BR-FLT-07). It is
 *   stored on the booking and carried by the audit entry and the event;
 * - `scope` decides which bookings it reaches; `auditActor` who did it.
 */
export type CancelBookingInTransaction = (
  input: Readonly<{
    bookingId: string;
    scope: BookingAccessScope;
    reason: CancellationReason;
    auditActor: AuditActor;
    now: Date;
  }>,
) => Promise<CancelBookingResult>;

type CancelBookingInTransactionDependencies = {
  bookingRepository: BookingRepository;
  paymentRepository: PaymentRepository;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
};

/**
 * In the lock order of the table in domain-model: the booking and its
 * seats (BookingRepository.cancel checks every condition in its own
 * statement and releases the seats only when it wins), then the payment —
 * SUCCEEDED → REFUND_PENDING, due now. The refund itself is the
 * reconciliation job's (Decision 15): this never calls the gateway
 * (ADR-009), and the booking is never cancelled with its money still taken,
 * nor the money refunded for a booking that stands.
 *
 * Must run inside a transaction: the audit recorder and the outbox refuse
 * to write outside one.
 */
export function createCancelBookingInTransaction(
  dependencies: CancelBookingInTransactionDependencies,
): CancelBookingInTransaction {
  const {
    bookingRepository,
    paymentRepository,
    auditRecorder,
    outboxRepository,
    generateAuditId,
    generateOutboxId,
    getRequestId,
  } = dependencies;

  return async ({ bookingId, scope, reason, auditActor, now }) => {
    const cancelResult = await bookingRepository.cancel(bookingId, scope, now, reason);

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
        reason,
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
          cancellationReason: reason,
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
      reason,
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
  };
}

type CancelBookingDependencies = CancelBookingInTransactionDependencies & {
  transactionRunner: TransactionRunner;
  getCurrentTime: () => Date;
};

/**
 * The owner cancels (US-BOOK-05): the core with reason CUSTOMER, in a
 * transaction of its own. A HELD booking is limited only by its own hold:
 * once lapsed (BR-BOOK-10) it is expired, not cancelled — `expired`,
 * nothing written, the expiry job ends it (Decision 12). A CONFIRMED one
 * only more than 24 h before departure (BR-BOOK-06); its payment is
 * refunded in full (Decision 16).
 *
 * `now` is read once and used for the decisions and the audit/event time.
 */
export function createCancelBooking(
  dependencies: CancelBookingDependencies,
): CancelBooking {
  const { transactionRunner, getCurrentTime } = dependencies;
  const cancelInTransaction = createCancelBookingInTransaction(dependencies);

  return async (
    bookingId: string,
    scope: BookingAccessScope,
    actor: Actor,
  ): Promise<CancelBookingResult> => {
    if (!isUuid(bookingId)) {
      return { outcome: "not-found" };
    }

    const now = getCurrentTime();

    return transactionRunner.run(() =>
      cancelInTransaction({
        bookingId,
        scope,
        reason: "CUSTOMER",
        auditActor: { type: "account", id: actor.accountId },
        now,
      }),
    );
  };
}
