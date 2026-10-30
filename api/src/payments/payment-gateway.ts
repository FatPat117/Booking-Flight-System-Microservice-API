import type { Money } from "../money/money.js";

/**
 * The payment provider, seen from the booking side (Day 49B, ADR-009).
 *
 * Never called inside a database transaction: it may take seconds and it
 * cannot be rolled back. Async from the start, like every port that can
 * touch I/O.
 *
 * `paymentId` is our own payment id, sent as the provider's idempotency key:
 * charging the same `paymentId` twice must take the money once and answer the
 * same result, and so must refunding it twice. Real providers (Stripe, VNPay,
 * ...) support this; it is what makes reconciliation's second charge safe
 * (Day 49C, ADR-010).
 *
 * Every call has a third result besides success and refusal: `unknown`, when
 * no answer came back in time. The adapter applies the timeout and returns
 * it as a value; callers never time a call themselves, and must never read
 * `unknown` as a failure — the provider may have acted.
 *
 * Must not know: bookings, HTTP, the database, Idempotency-Key records.
 */
export type ChargeRequest = Readonly<{
  paymentId: string;
  amount: Money;
  /** Opaque token from the client's payment form; never a card number. */
  paymentMethodToken: string;
}>;

export type ChargeResult =
  | Readonly<{ outcome: "succeeded"; providerReference: string }>
  | Readonly<{ outcome: "declined"; reason: string }>
  | Readonly<{ outcome: "unknown"; reason: string }>;

export type RefundRequest = Readonly<{
  paymentId: string;
  providerReference: string;
  amount: Money;
}>;

export type RefundResult =
  | Readonly<{ outcome: "refunded" }>
  /** `retryable: false` when trying again cannot help (e.g. a closed card account). */
  | Readonly<{ outcome: "failed"; reason: string; retryable: boolean }>
  | Readonly<{ outcome: "unknown"; reason: string }>;

export type PaymentGateway = Readonly<{
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}>;
