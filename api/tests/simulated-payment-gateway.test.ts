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

/**
 * A clock the test drives (Day 51): the two tests below used to measure real
 * milliseconds (`elapsed >= 45 && < 1000`), the kind of bound a loaded machine
 * breaks. Here a wait resolves only when told to, and the timeout fires only
 * when the test aborts it. The "never answers" tokens still run on the real
 * clock with SHORT_TIMEOUT_MS, but assert only outcomes, never durations.
 */
function manualTimers() {
  const waits: number[] = [];
  const timeouts: number[] = [];
  const controllers: AbortController[] = [];
  let releaseWaits = true;

  return {
    waits,
    timeouts,
    holdWaits() {
      releaseWaits = false;
    },
    fireTimeouts() {
      for (const controller of controllers) {
        controller.abort(new DOMException("timed out", "TimeoutError"));
      }
    },
    timers: {
      wait(ms: number, signal: AbortSignal) {
        waits.push(ms);
        if (releaseWaits) {
          return Promise.resolve();
        }
        return new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      timeoutSignal(ms: number) {
        timeouts.push(ms);
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      },
    },
  };
}

test("delayMs is waited once per call, under the adapter's timeout", async () => {
  const clock = manualTimers();
  const gateway = createSimulatedPaymentGateway({ delayMs: 40, timeoutMs: 1_000, timers: clock.timers });
  const request = charge(SIMULATOR_SUCCESS_TOKEN);

  await gateway.charge(request);
  await gateway.refund(refundOf(request.paymentId));

  assert.deepEqual(clock.waits, [40, 40]);
  assert.deepEqual(clock.timeouts, [1_000, 1_000]);
});

test("the timeout aborts a slow call and answers unknown instead of waiting for it", async () => {
  const clock = manualTimers();
  const gateway = createSimulatedPaymentGateway({ delayMs: 5_000, timeoutMs: 50, timers: clock.timers });
  const request = charge(SIMULATOR_SUCCESS_TOKEN);
  clock.holdWaits();

  let settled = false;
  const pending = gateway.charge(request).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the call must still be waiting before the timeout fires");

  clock.fireTimeouts();
  assert.deepEqual(await pending, { outcome: "unknown", reason: "timeout" });

  const refund = gateway.refund(refundOf(request.paymentId));
  clock.fireTimeouts();
  assert.deepEqual(await refund, { outcome: "unknown", reason: "timeout" });
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
