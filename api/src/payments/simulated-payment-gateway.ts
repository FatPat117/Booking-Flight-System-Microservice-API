import { setTimeout as sleep } from "node:timers/promises";

import type {
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
  RefundRequest,
  RefundResult,
} from "./payment-gateway.js";

export const SIMULATOR_SUCCESS_TOKEN = "tok_success";
export const SIMULATOR_DECLINE_TOKEN = "tok_decline";
/** First charge of a payment never reaches the provider; later ones succeed. */
export const SIMULATOR_TIMEOUT_BEFORE_CHARGE_TOKEN = "tok_timeout_before_charge";
/** First charge takes the money but its answer is lost; later ones answer it. */
export const SIMULATOR_LOST_RESPONSE_TOKEN = "tok_lost_response";
/** Charges; the first two refunds fail as retryable, the third refunds. */
export const SIMULATOR_REFUND_FAILS_TWICE_TOKEN = "tok_refund_fails_twice";
/** Charges; every refund fails as not retryable. */
export const SIMULATOR_REFUND_FAILS_PERMANENTLY_TOKEN = "tok_refund_fails_permanently";

const CHARGING_TOKENS = new Set([
  SIMULATOR_SUCCESS_TOKEN,
  SIMULATOR_TIMEOUT_BEFORE_CHARGE_TOKEN,
  SIMULATOR_LOST_RESPONSE_TOKEN,
  SIMULATOR_REFUND_FAILS_TWICE_TOKEN,
  SIMULATOR_REFUND_FAILS_PERMANENTLY_TOKEN,
]);
const TRANSIENT_REFUND_FAILURES = 2;

/**
 * The development gateway (Day 49B): the token decides the outcome —
 * `tok_success` charges, `tok_decline` is declined `card_declined`, anything
 * unknown is declined `unknown_payment_method`, the way a provider answers a
 * token it never issued. Day 49C adds the failure tokens above, one per
 * stopping point reconciliation must finish.
 *
 * It keeps the provider-side idempotency the port promises: once a payment id
 * has a result, charging it again answers that result, and refunding twice
 * answers `refunded` twice. A refund of a charge it never made fails
 * `unknown_charge`, not retryable.
 *
 * `timeoutMs` is the adapter's own limit (Day 49C): the call is aborted when
 * it runs out and answers `unknown`. What the "provider" did before the abort
 * stays done — that is the lost-response case. `delayMs` is the simulated
 * network time per call.
 *
 * Limitation: the provider's memory lives in the api process, so a restart
 * forgets every charge, and a charge after a restart is a new charge. A real
 * provider does not forget (ADR-010).
 */
export function createSimulatedPaymentGateway(options: {
  delayMs: number;
  timeoutMs: number;
}): PaymentGateway {
  const charges = new Map<string, ChargeResult>();
  const tokens = new Map<string, string>();
  const unreachedOnce = new Set<string>();
  const refunded = new Set<string>();
  const refundAttempts = new Map<string, number>();

  async function network(signal: AbortSignal): Promise<void> {
    if (options.delayMs > 0) {
      await sleep(options.delayMs, undefined, { signal });
    }
  }

  async function provider(
    request: ChargeRequest,
    signal: AbortSignal,
  ): Promise<ChargeResult> {
    const previous = charges.get(request.paymentId);
    if (previous !== undefined) {
      return previous;
    }

    const token = request.paymentMethodToken;

    if (
      token === SIMULATOR_TIMEOUT_BEFORE_CHARGE_TOKEN &&
      !unreachedOnce.has(request.paymentId)
    ) {
      unreachedOnce.add(request.paymentId);
      return untilAborted(signal);
    }

    const result: ChargeResult = CHARGING_TOKENS.has(token)
      ? { outcome: "succeeded", providerReference: `sim_ch_${request.paymentId}` }
      : {
          outcome: "declined",
          reason:
            token === SIMULATOR_DECLINE_TOKEN ? "card_declined" : "unknown_payment_method",
        };
    charges.set(request.paymentId, result);
    tokens.set(request.paymentId, token);

    if (token === SIMULATOR_LOST_RESPONSE_TOKEN && !unreachedOnce.has(request.paymentId)) {
      unreachedOnce.add(request.paymentId);
      return untilAborted(signal);
    }

    return result;
  }

  function refundAtProvider(request: RefundRequest, token: string): RefundResult {
    if (refunded.has(request.paymentId)) {
      return { outcome: "refunded" };
    }

    if (token === SIMULATOR_REFUND_FAILS_PERMANENTLY_TOKEN) {
      return { outcome: "failed", reason: "card_account_closed", retryable: false };
    }

    const attempt = (refundAttempts.get(request.paymentId) ?? 0) + 1;
    refundAttempts.set(request.paymentId, attempt);
    if (token === SIMULATOR_REFUND_FAILS_TWICE_TOKEN && attempt <= TRANSIENT_REFUND_FAILURES) {
      return { outcome: "failed", reason: "provider_unavailable", retryable: true };
    }

    refunded.add(request.paymentId);
    return { outcome: "refunded" };
  }

  async function withTimeout<T>(
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const signal = AbortSignal.timeout(options.timeoutMs);
    try {
      return await call(signal);
    } catch (error) {
      if (signal.aborted) {
        return undefined;
      }
      throw error;
    }
  }

  return {
    async charge(request) {
      const result = await withTimeout(async (signal) => {
        await network(signal);
        return provider(request, signal);
      });
      return result ?? { outcome: "unknown", reason: "timeout" };
    },

    async refund(request) {
      const result = await withTimeout(async (signal) => {
        await network(signal);
        const charge = charges.get(request.paymentId);
        if (
          charge?.outcome !== "succeeded" ||
          charge.providerReference !== request.providerReference
        ) {
          return { outcome: "failed", reason: "unknown_charge", retryable: false } as const;
        }
        return refundAtProvider(request, tokens.get(request.paymentId) ?? "");
      });
      return result ?? { outcome: "unknown", reason: "timeout" };
    },
  };
}

/** A provider that never answers: only the caller's abort ends the wait. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
