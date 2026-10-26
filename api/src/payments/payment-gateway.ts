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
 * same result. Real providers (Stripe, VNPay, ...) support this; it is what
 * will make a retry or reconciliation safe once timeouts exist (49C).
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
  | Readonly<{ outcome: "declined"; reason: string }>;

export type RefundRequest = Readonly<{
  paymentId: string;
  providerReference: string;
  amount: Money;
}>;

export type RefundResult =
  | Readonly<{ outcome: "refunded" }>
  | Readonly<{ outcome: "failed"; reason: string }>;

export type PaymentGateway = Readonly<{
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}>;
