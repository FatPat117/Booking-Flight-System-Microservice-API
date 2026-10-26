import assert from "node:assert/strict";
import test from "node:test";

import { vnd } from "../src/money/money.js";
import {
  createSimulatedPaymentGateway,
  SIMULATOR_DECLINE_TOKEN,
  SIMULATOR_SUCCESS_TOKEN,
} from "../src/payments/simulated-payment-gateway.js";

const AMOUNT = vnd(3_000_000);

function charge(token: string, paymentId = crypto.randomUUID()) {
  return { paymentId, amount: AMOUNT, paymentMethodToken: token };
}

test("tok_success charges and returns a provider reference derived from the payment id", async () => {
  const gateway = createSimulatedPaymentGateway({ delayMs: 0 });
  const request = charge(SIMULATOR_SUCCESS_TOKEN);

  assert.deepEqual(await gateway.charge(request), {
    outcome: "succeeded",
    providerReference: `sim_ch_${request.paymentId}`,
  });
});

test("tok_decline is declined as card_declined", async () => {
  const gateway = createSimulatedPaymentGateway({ delayMs: 0 });

  assert.deepEqual(await gateway.charge(charge(SIMULATOR_DECLINE_TOKEN)), {
    outcome: "declined",
    reason: "card_declined",
  });
});

test("a token the simulator never issued is declined as unknown_payment_method", async () => {
  const gateway = createSimulatedPaymentGateway({ delayMs: 0 });

  assert.deepEqual(await gateway.charge(charge("tok_4242424242424242")), {
    outcome: "declined",
    reason: "unknown_payment_method",
  });
});

test("charging the same payment id twice answers the first result, even with another token (provider-side idempotency)", async () => {
  const gateway = createSimulatedPaymentGateway({ delayMs: 0 });
  const paymentId = crypto.randomUUID();

  const first = await gateway.charge(charge(SIMULATOR_SUCCESS_TOKEN, paymentId));
  const second = await gateway.charge(charge(SIMULATOR_DECLINE_TOKEN, paymentId));

  assert.deepEqual(second, first);
  assert.equal(first.outcome, "succeeded");
});

test("a succeeded charge can be refunded, and refunding it again still answers refunded", async () => {
  const gateway = createSimulatedPaymentGateway({ delayMs: 0 });
  const request = charge(SIMULATOR_SUCCESS_TOKEN);
  const charged = await gateway.charge(request);
  assert.equal(charged.outcome, "succeeded");

  const refund = {
    paymentId: request.paymentId,
    providerReference: charged.providerReference,
    amount: AMOUNT,
  };
  assert.deepEqual(await gateway.refund(refund), { outcome: "refunded" });
  assert.deepEqual(await gateway.refund(refund), { outcome: "refunded" });
});

test("refunding a charge the simulator never made fails unknown_charge", async () => {
  const gateway = createSimulatedPaymentGateway({ delayMs: 0 });
  const declined = charge(SIMULATOR_DECLINE_TOKEN);
  await gateway.charge(declined);

  for (const paymentId of [declined.paymentId, crypto.randomUUID()]) {
    assert.deepEqual(
      await gateway.refund({ paymentId, providerReference: "sim_ch_x", amount: AMOUNT }),
      { outcome: "failed", reason: "unknown_charge" },
    );
  }
});

test("delayMs makes every call take at least that long", async () => {
  const gateway = createSimulatedPaymentGateway({ delayMs: 40 });

  const started = performance.now();
  await gateway.charge(charge(SIMULATOR_SUCCESS_TOKEN));
  const elapsed = performance.now() - started;

  assert.ok(elapsed >= 35, `charge took ${elapsed.toFixed(1)} ms`);
});
