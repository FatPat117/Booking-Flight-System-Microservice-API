import type { Booking } from "../bookings/booking-repository.js";
import type { StoredResponse } from "../idempotency/idempotency-repository.js";
import type { ApiErrorResponse } from "../types.js";
import type { Payment } from "./payment-repository.js";

/**
 * Why a booking cannot be paid (409 BOOKING_NOT_PAYABLE):
 * - not-held: not HELD, or its hold has lapsed (BR-PAY-04, BR-BOOK-10).
 * - under-margin: 60 s or less left, too little to start (BR-PAY-07).
 * - refunded: charged, but cancelled or expired before phase 3 confirmed it.
 */
export type NotPayableReason = "not-held" | "under-margin" | "refunded";

/** A final outcome of paying for a booking: stored with the key and replayed. */
export type PaymentDecision =
  | Readonly<{ outcome: "confirmed"; booking: Booking; payment: Payment }>
  | Readonly<{ outcome: "declined"; payment: Payment }>
  | Readonly<{ outcome: "not-payable"; reason: NotPayableReason }>
  | Readonly<{ outcome: "not-found" }>;

const NOT_PAYABLE_MESSAGES: Record<NotPayableReason, string> = {
  "not-held": "Booking is not held or its hold has expired",
  "under-margin": "Booking hold expires in 60 seconds or less; it can no longer be paid",
  refunded: "Booking was cancelled or expired while the payment was processed; the payment was refunded",
};

function error(status: number, code: string, message: string): StoredResponse {
  const body: ApiErrorResponse = { error: { code, message } };
  return { status, body };
}

/**
 * The HTTP response for a final outcome. The one place outside app.ts that
 * knows status codes, because Decision 14 stores the response in the same
 * transaction as the outcome — before any route sees it. A replay sends it
 * back unchanged, so the route never rebuilds it.
 */
export function toStoredResponse(decision: PaymentDecision): StoredResponse {
  switch (decision.outcome) {
    case "confirmed": {
      const { payment, booking } = decision;
      return {
        status: 201,
        body: {
          payment: {
            id: payment.id,
            bookingId: payment.bookingId,
            status: payment.status,
            amount: payment.amount,
            providerReference: payment.providerReference,
            createdAt: payment.createdAt,
          },
          booking,
        },
      };
    }
    case "declined":
      return error(
        402,
        "PAYMENT_DECLINED",
        `Payment was declined: ${decision.payment.failureReason ?? "unknown"}`,
      );
    case "not-payable":
      return error(409, "BOOKING_NOT_PAYABLE", NOT_PAYABLE_MESSAGES[decision.reason]);
    case "not-found":
      return error(404, "BOOKING_NOT_FOUND", "Booking was not found");
  }
}
