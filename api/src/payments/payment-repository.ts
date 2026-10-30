import type { Money } from "../money/money.js";

/** domain-model "Lifecycles → Payment" (Decisions 14 and 15). */
export type PaymentStatus =
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "REFUND_FAILED";

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
  /** Why the gateway declined (FAILED) or the refund gave up (REFUND_FAILED). */
  failureReason: string | null;
  /**
   * The token the payment was started with; kept only while PROCESSING, so
   * reconciliation can charge again with the same payment id (Decision 15).
   */
  paymentMethodToken: string | null;
  /** Reconciliation attempts in the current state (BR-PAY-09). */
  attempts: number;
  /**
   * When reconciliation may touch it next; set exactly while PROCESSING or
   * REFUND_PENDING. Age gate, lease and backoff in one (Decision 15).
   */
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

/** What phase 1 records: always PROCESSING, nothing from the gateway yet. */
export type NewPayment = Readonly<{
  id: string;
  bookingId: string;
  accountId: string;
  amount: Money;
  paymentMethodToken: string;
  /** Past the live request's own gateway timeout (Decision 15). */
  nextAttemptAt: string;
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
 * Leaving PROCESSING clears the payment-method token; reaching a terminal
 * state clears next_attempt_at, so reconciliation never picks it again.
 *
 * Every transition is conditional on the state it leaves, like a booking's
 * (ADR-004). A transition that matches no row throws, rolling its
 * transaction back: the request and the reconciliation job only meet on the
 * same payment when the age gate and the lease were both outrun, and then
 * the loser must change nothing (Decision 15).
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
  /**
   * PROCESSING → REFUND_PENDING: charged, but the booking was not confirmed.
   * Due at once (`next_attempt_at = now`, attempts from 0): the job refunds.
   */
  markRefundPending(paymentId: string, providerReference: string, now: Date): Promise<void>;
  /** REFUND_PENDING → REFUNDED. */
  markRefunded(paymentId: string, now: Date): Promise<void>;
  /** REFUND_PENDING → REFUND_FAILED: no more retries, a person settles it (BR-PAY-09). */
  markRefundFailed(paymentId: string, reason: string, now: Date): Promise<void>;
  /**
   * Reconciliation's claim (Decision 15): up to `limit` PROCESSING or
   * REFUND_PENDING payments whose next_attempt_at has passed, oldest first,
   * skipping rows another transaction has locked. Each is leased — its
   * next_attempt_at moved to `now + leaseMs` — and its attempt counted, so
   * another instance leaves it alone once this transaction commits. Returns
   * them as they are after the claim, ordered by id.
   */
  claimDue(now: Date, leaseMs: number, limit: number): Promise<Payment[]>;
  /**
   * Try again at `nextAttemptAt` (a retry backoff); the payment stays in
   * `status`. Throws if it is no longer in that state.
   */
  reschedule(
    paymentId: string,
    status: "PROCESSING" | "REFUND_PENDING",
    nextAttemptAt: Date,
  ): Promise<void>;
  /** No scope: no route reads a payment; tests and reconciliation do. */
  findById(paymentId: string): Promise<Payment | undefined>;
}>;
