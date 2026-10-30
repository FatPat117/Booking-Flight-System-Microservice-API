import assert from "node:assert/strict";
import test from "node:test";

import { vnd } from "../src/money/money.js";
import {
  createSimulatedPaymentGateway,
  SIMULATOR_DECLINE_TOKEN,
  SIMULATOR_LOST_RESPONSE_TOKEN,
  SIMULATOR_REFUND_FAILS_PERMANENTLY_TOKEN,
  SIMULATOR_REFUND_FAILS_TWICE_TOKEN,
  SIMULATOR_SUCCESS_TOKEN,
  SIMULATOR_TIMEOUT_BEFORE_CHARGE_TOKEN,
} from "../src/payments/simulated-payment-gateway.js";

const AMOUNT = vnd(3_000_000);
/** Short enough that the "never answers" tokens keep the suite fast. */
const SHORT_TIMEOUT_MS = 30;

function simulator(options: { delayMs?: number; timeoutMs?: number } = {}) {
  return createSimulatedPaymentGateway({
    delayMs: options.delayMs ?? 0,
    timeoutMs: options.timeoutMs ?? SHORT_TIMEOUT_MS,
  });
}

function charge(token: string, paymentId = crypto.randomUUID()) {
  return { paymentId, amount: AMOUNT, paymentMethodToken: token };
}

function refundOf(paymentId: string) {
  return { paymentId, providerReference: `sim_ch_${paymentId}`, amount: AMOUNT };
}

test("tok_success charges and returns a provider reference derived from the payment id", async () => {
  const gateway = simulator();
  const request = charge(SIMULATOR_SUCCESS_TOKEN);

  assert.deepEqual(await gateway.charge(request), {
    outcome: "succeeded",
    providerReference: `sim_ch_${request.paymentId}`,
  });
});

test("tok_decline is declined as card_declined", async () => {
  const gateway = simulator();

  assert.deepEqual(await gateway.charge(charge(SIMULATOR_DECLINE_TOKEN)), {
    outcome: "declined",
    reason: "card_declined",
  });
});

test("a token the simulator never issued is declined as unknown_payment_method", async () => {
  const gateway = simulator();

  assert.deepEqual(await gateway.charge(charge("tok_4242424242424242")), {
    outcome: "declined",
    reason: "unknown_payment_method",
  });
});

test("charging the same payment id twice answers the first result, even with another token (provider-side idempotency)", async () => {
  const gateway = simulator();
  const paymentId = crypto.randomUUID();

  const first = await gateway.charge(charge(SIMULATOR_SUCCESS_TOKEN, paymentId));
  const second = await gateway.charge(charge(SIMULATOR_DECLINE_TOKEN, paymentId));

  assert.deepEqual(second, first);
  assert.equal(first.outcome, "succeeded");
});

test("a succeeded charge can be refunded, and refunding it again still answers refunded", async () => {
  const gateway = simulator();
  const request = charge(SIMULATOR_SUCCESS_TOKEN);
  await gateway.charge(request);

  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), { outcome: "refunded" });
  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), { outcome: "refunded" });
});

test("refunding a charge the simulator never made fails unknown_charge, not retryable", async () => {
  const gateway = simulator();
  const declined = charge(SIMULATOR_DECLINE_TOKEN);
  await gateway.charge(declined);

  for (const paymentId of [declined.paymentId, crypto.randomUUID()]) {
    assert.deepEqual(
      await gateway.refund({ paymentId, providerReference: "sim_ch_x", amount: AMOUNT }),
      { outcome: "failed", reason: "unknown_charge", retryable: false },
    );
  }
});

test("delayMs makes every call take at least that long", async () => {
  const gateway = simulator({ delayMs: 40, timeoutMs: 1_000 });

  const started = performance.now();
  await gateway.charge(charge(SIMULATOR_SUCCESS_TOKEN));
  const elapsed = performance.now() - started;

  assert.ok(elapsed >= 35, `charge took ${elapsed.toFixed(1)} ms`);
});

test("the timeout aborts a slow call and answers unknown instead of waiting for it", async () => {
  const gateway = simulator({ delayMs: 5_000, timeoutMs: 50 });
  const request = charge(SIMULATOR_SUCCESS_TOKEN);

  const started = performance.now();
  const result = await gateway.charge(request);
  const elapsed = performance.now() - started;

  assert.deepEqual(result, { outcome: "unknown", reason: "timeout" });
  assert.ok(elapsed >= 45 && elapsed < 1_000, `charge took ${elapsed.toFixed(1)} ms`);
  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), {
    outcome: "unknown",
    reason: "timeout",
  });
});

test("tok_timeout_before_charge: the first charge never reaches the provider, so it takes no money; charging the same id again succeeds", async () => {
  const gateway = simulator();
  const request = charge(SIMULATOR_TIMEOUT_BEFORE_CHARGE_TOKEN);

  assert.deepEqual(await gateway.charge(request), { outcome: "unknown", reason: "timeout" });
  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), {
    outcome: "failed",
    reason: "unknown_charge",
    retryable: false,
  });

  assert.deepEqual(await gateway.charge(request), {
    outcome: "succeeded",
    providerReference: `sim_ch_${request.paymentId}`,
  });
});

test("tok_lost_response: the provider takes the money but the answer is lost; charging the same id again answers that charge instead of charging twice", async () => {
  const gateway = simulator();
  const request = charge(SIMULATOR_LOST_RESPONSE_TOKEN);

  assert.deepEqual(await gateway.charge(request), { outcome: "unknown", reason: "timeout" });

  assert.deepEqual(await gateway.charge(request), {
    outcome: "succeeded",
    providerReference: `sim_ch_${request.paymentId}`,
  });
  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), { outcome: "refunded" });
});

test("tok_refund_fails_twice: the first two refunds fail as retryable, the third refunds, and a fourth still answers refunded", async () => {
  const gateway = simulator();
  const request = charge(SIMULATOR_REFUND_FAILS_TWICE_TOKEN);
  await gateway.charge(request);
  const transient = { outcome: "failed", reason: "provider_unavailable", retryable: true };

  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), transient);
  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), transient);
  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), { outcome: "refunded" });
  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), { outcome: "refunded" });
});

test("tok_refund_fails_permanently: every refund fails as not retryable", async () => {
  const gateway = simulator();
  const request = charge(SIMULATOR_REFUND_FAILS_PERMANENTLY_TOKEN);
  await gateway.charge(request);
  const permanent = { outcome: "failed", reason: "card_account_closed", retryable: false };

  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), permanent);
  assert.deepEqual(await gateway.refund(refundOf(request.paymentId)), permanent);
});
