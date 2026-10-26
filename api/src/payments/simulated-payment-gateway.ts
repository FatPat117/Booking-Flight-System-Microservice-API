import type {
  ChargeResult,
  PaymentGateway,
  RefundResult,
} from "./payment-gateway.js";

export const SIMULATOR_SUCCESS_TOKEN = "tok_success";
export const SIMULATOR_DECLINE_TOKEN = "tok_decline";

/**
 * The development gateway (Day 49B): the token decides the outcome —
 * `tok_success` charges, `tok_decline` is declined `card_declined`, anything
 * else is declined `unknown_payment_method`, the way a provider answers a
 * token it never issued.
 *
 * It keeps the provider-side idempotency the port promises: the same
 * `paymentId` charged twice answers the first result again, and refunding a
 * charge twice answers `refunded` twice. A refund of a charge it never made
 * fails `unknown_charge`.
 *
 * Limitation, on purpose for today: it runs inside the api process, so there
 * is no network, no timeout and no "the call failed and we do not know if it
 * charged". `delayMs` only makes the gateway slow, to reproduce the
 * payment-vs-expiry race by hand. The hard failures are 49C's.
 */
export function createSimulatedPaymentGateway(options: {
  delayMs: number;
}): PaymentGateway {
  const charges = new Map<string, ChargeResult>();

  async function wait(): Promise<void> {
    if (options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  return {
    async charge(request) {
      await wait();

      const previous = charges.get(request.paymentId);
      if (previous !== undefined) {
        return previous;
      }

      const result: ChargeResult =
        request.paymentMethodToken === SIMULATOR_SUCCESS_TOKEN
          ? { outcome: "succeeded", providerReference: `sim_ch_${request.paymentId}` }
          : {
              outcome: "declined",
              reason:
                request.paymentMethodToken === SIMULATOR_DECLINE_TOKEN
                  ? "card_declined"
                  : "unknown_payment_method",
            };

      charges.set(request.paymentId, result);
      return result;
    },

    async refund(request): Promise<RefundResult> {
      await wait();

      const charge = charges.get(request.paymentId);
      if (
        charge?.outcome !== "succeeded" ||
        charge.providerReference !== request.providerReference
      ) {
        return { outcome: "failed", reason: "unknown_charge" };
      }

      return { outcome: "refunded" };
    },
  };
}
