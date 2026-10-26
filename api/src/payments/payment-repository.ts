import type { Money } from "../money/money.js";

/** domain-model "Lifecycles → Payment" (Decision 14). */
export type PaymentStatus =
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "REFUND_PENDING"
  | "REFUNDED";

export type Payment = Readonly<{
  id: string;
  bookingId: string;
  /** The payer: the booking's owner (JWT `sub`). */
  accountId: string;
  /** The booking total captured in phase 1; never re-read. */
  amount: Money;
  status: PaymentStatus;
  /** The gateway's charge id; set from SUCCEEDED / REFUND_PENDING on. */
  providerReference: string | null;
  /** Why the gateway declined; set exactly when FAILED. */
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}>;

/** What phase 1 records: always PROCESSING, nothing from the gateway yet. */
export type NewPayment = Readonly<{
  id: string;
  bookingId: string;
  accountId: string;
  amount: Money;
  createdAt: string;
}>;

/**
 * - payment-in-progress: the booking already has a PROCESSING payment
 *   (another key, another tab). Nothing was written and the transaction is
 *   still usable.
 */
export type StartPaymentResult =
  | { outcome: "started" }
  | { outcome: "payment-in-progress" };

/**
 * Payments of bookings (Day 49B, Decision 14, ADR-009).
 *
 * Every transition is conditional on the state it leaves, like a booking's
 * (ADR-004). Only the request holding the payment's Idempotency-Key moves
 * it, so a transition that matches no row is a bug and throws; it is not
 * an outcome.
 *
 * Must not know: HTTP, the gateway, Idempotency-Keys, the database driver.
 */
export type PaymentRepository = Readonly<{
  /**
   * Record a PROCESSING payment, unless the booking has one already. A
   * concurrent start for the same booking waits for the first one's
   * transaction, then answers payment-in-progress (or starts, if it rolled
   * back).
   */
  start(payment: NewPayment): Promise<StartPaymentResult>;
  /** PROCESSING → SUCCEEDED. At most one per booking (BR-PAY-05). */
  markSucceeded(paymentId: string, providerReference: string, now: Date): Promise<void>;
  /** PROCESSING → FAILED: the gateway declined. */
  markFailed(paymentId: string, reason: string, now: Date): Promise<void>;
  /** PROCESSING → REFUND_PENDING: charged, but the booking was not confirmed. */
  markRefundPending(paymentId: string, providerReference: string, now: Date): Promise<void>;
  /** REFUND_PENDING → REFUNDED. */
  markRefunded(paymentId: string, now: Date): Promise<void>;
  /** No scope: no route reads a payment; tests and reconciliation (49C) do. */
  findById(paymentId: string): Promise<Payment | undefined>;
}>;
