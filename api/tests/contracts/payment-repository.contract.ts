import assert from "node:assert/strict";
import test from "node:test";

import { vnd } from "../../src/money/money.js";
import type {
  NewPayment,
  PaymentRepository,
} from "../../src/payments/payment-repository.js";
import { FIXTURE_ACCOUNT_A as ACCOUNT_A } from "../fixtures/bookings.js";

/**
 * What every PaymentRepository promises (Day 49B, Decision 14), run against
 * the in-memory fake (unit tier) and Postgres (integration tier). Not a
 * *.test.ts file: it registers tests only when a runner file calls it.
 */
export type PaymentRepositoryContractSubject = Readonly<{
  repository: PaymentRepository;
  /** A stored booking to pay for; returns its id (Postgres checks the FK). */
  seedBooking(): Promise<string>;
}>;

const NOW = new Date("2026-10-10T00:00:00.000Z");
const LATER = new Date("2026-10-10T00:00:03.000Z");

function newPayment(bookingId: string): NewPayment {
  return {
    id: crypto.randomUUID(),
    bookingId,
    accountId: ACCOUNT_A,
    amount: vnd(3_000_000),
    createdAt: NOW.toISOString(),
  };
}

export function runPaymentRepositoryContract(
  implementation: string,
  setup: () => Promise<PaymentRepositoryContractSubject>,
): void {
  const name = (behavior: string) =>
    `PaymentRepository contract (${implementation}): ${behavior}`;

  test(name("start records a PROCESSING payment with the captured amount, nothing from the gateway yet"), async () => {
    const { repository, seedBooking } = await setup();
    const payment = newPayment(await seedBooking());

    assert.deepEqual(await repository.start(payment), { outcome: "started" });
    assert.deepEqual(await repository.findById(payment.id), {
      ...payment,
      status: "PROCESSING",
      providerReference: null,
      failureReason: null,
      updatedAt: NOW.toISOString(),
    });
  });

  test(name("a second start for a booking with a PROCESSING payment is payment-in-progress and stores nothing"), async () => {
    const { repository, seedBooking } = await setup();
    const bookingId = await seedBooking();
    const otherBookingId = await seedBooking();
    await repository.start(newPayment(bookingId));
    const second = newPayment(bookingId);

    assert.deepEqual(await repository.start(second), { outcome: "payment-in-progress" });
    assert.equal(await repository.findById(second.id), undefined);
    // Only the same booking is affected.
    assert.deepEqual(await repository.start(newPayment(otherBookingId)), { outcome: "started" });
  });

  test(name("once the first payment has left PROCESSING, the booking can start another"), async () => {
    const { repository, seedBooking } = await setup();
    const bookingId = await seedBooking();
    const declined = newPayment(bookingId);
    await repository.start(declined);
    await repository.markFailed(declined.id, "card_declined", LATER);

    assert.deepEqual(await repository.start(newPayment(bookingId)), { outcome: "started" });
  });

  test(name("each transition records its data and the time it happened"), async () => {
    const { repository, seedBooking } = await setup();
    const succeeded = newPayment(await seedBooking());
    const failed = newPayment(await seedBooking());
    const refunded = newPayment(await seedBooking());
    for (const payment of [succeeded, failed, refunded]) {
      await repository.start(payment);
    }

    await repository.markSucceeded(succeeded.id, "ch_1", LATER);
    await repository.markFailed(failed.id, "card_declined", LATER);
    await repository.markRefundPending(refunded.id, "ch_3", LATER);
    const pending = await repository.findById(refunded.id);
    await repository.markRefunded(refunded.id, new Date(LATER.getTime() + 1_000));

    const updatedAt = LATER.toISOString();
    assert.deepEqual(await repository.findById(succeeded.id), {
      ...succeeded,
      status: "SUCCEEDED",
      providerReference: "ch_1",
      failureReason: null,
      updatedAt,
    });
    assert.deepEqual(await repository.findById(failed.id), {
      ...failed,
      status: "FAILED",
      providerReference: null,
      failureReason: "card_declined",
      updatedAt,
    });
    assert.equal(pending?.status, "REFUND_PENDING");
    // The reference written by REFUND_PENDING is kept: the refund needs it.
    assert.deepEqual(await repository.findById(refunded.id), {
      ...refunded,
      status: "REFUNDED",
      providerReference: "ch_3",
      failureReason: null,
      updatedAt: "2026-10-10T00:00:04.000Z",
    });
  });

  test(name("a transition from the wrong state throws and changes nothing"), async () => {
    const { repository, seedBooking } = await setup();
    const payment = newPayment(await seedBooking());
    await repository.start(payment);

    await assert.rejects(repository.markRefunded(payment.id, LATER));
    await repository.markSucceeded(payment.id, "ch_1", LATER);
    await assert.rejects(repository.markSucceeded(payment.id, "ch_2", LATER));
    await assert.rejects(repository.markFailed(payment.id, "card_declined", LATER));
    await assert.rejects(repository.markSucceeded(crypto.randomUUID(), "ch_x", LATER));

    const stored = await repository.findById(payment.id);
    assert.equal(stored?.status, "SUCCEEDED");
    assert.equal(stored?.providerReference, "ch_1");
  });

  test(name("a booking never has two SUCCEEDED payments (BR-PAY-05)"), async () => {
    const { repository, seedBooking } = await setup();
    const bookingId = await seedBooking();
    const first = newPayment(bookingId);
    await repository.start(first);
    await repository.markSucceeded(first.id, "ch_1", LATER);
    const second = newPayment(bookingId);
    await repository.start(second);

    await assert.rejects(repository.markSucceeded(second.id, "ch_2", LATER));
  });

  test(name("findById of an unknown payment is undefined"), async () => {
    const { repository } = await setup();

    assert.equal(await repository.findById(crypto.randomUUID()), undefined);
  });
}
