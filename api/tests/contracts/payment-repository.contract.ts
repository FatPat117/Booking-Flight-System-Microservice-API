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
const RECONCILE_AT = "2026-10-10T00:00:40.000Z";

function newPayment(bookingId: string): NewPayment {
  return {
    id: crypto.randomUUID(),
    bookingId,
    accountId: ACCOUNT_A,
    amount: vnd(3_000_000),
    paymentMethodToken: "tok_success",
    nextAttemptAt: RECONCILE_AT,
    createdAt: NOW.toISOString(),
  };
}

/** Leaving PROCESSING clears the token and starts attempts from 0 (Day 49C). */
const finished = { paymentMethodToken: null, attempts: 0, nextAttemptAt: null } as const;

export function runPaymentRepositoryContract(
  implementation: string,
  setup: () => Promise<PaymentRepositoryContractSubject>,
): void {
  const name = (behavior: string) =>
    `PaymentRepository contract (${implementation}): ${behavior}`;

  test(name("start records a PROCESSING payment with the captured amount, its token and when reconciliation may take it, nothing from the gateway yet"), async () => {
    const { repository, seedBooking } = await setup();
    const payment = newPayment(await seedBooking());

    assert.deepEqual(await repository.start(payment), { outcome: "started" });
    assert.deepEqual(await repository.findById(payment.id), {
      ...payment,
      status: "PROCESSING",
      providerReference: null,
      failureReason: null,
      attempts: 0,
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
      ...finished,
      status: "SUCCEEDED",
      providerReference: "ch_1",
      failureReason: null,
      updatedAt,
    });
    assert.deepEqual(await repository.findById(failed.id), {
      ...failed,
      ...finished,
      status: "FAILED",
      providerReference: null,
      failureReason: "card_declined",
      updatedAt,
    });
    // REFUND_PENDING is due at once: the reconciliation job refunds it.
    assert.deepEqual(pending, {
      ...refunded,
      ...finished,
      nextAttemptAt: updatedAt,
      status: "REFUND_PENDING",
      providerReference: "ch_3",
      failureReason: null,
      updatedAt,
    });
    // The reference written by REFUND_PENDING is kept: the refund needs it.
    assert.deepEqual(await repository.findById(refunded.id), {
      ...refunded,
      ...finished,
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

  test(name("a refund the system gives up on becomes REFUND_FAILED with its reason, keeping the reference, and is never due again (BR-PAY-09)"), async () => {
    const { repository, seedBooking } = await setup();
    const payment = newPayment(await seedBooking());
    await repository.start(payment);

    await assert.rejects(repository.markRefundFailed(payment.id, "card_account_closed", LATER));
    await repository.markRefundPending(payment.id, "ch_1", LATER);
    await repository.markRefundFailed(
      payment.id,
      "card_account_closed",
      new Date(LATER.getTime() + 1_000),
    );

    assert.deepEqual(await repository.findById(payment.id), {
      ...payment,
      ...finished,
      status: "REFUND_FAILED",
      providerReference: "ch_1",
      failureReason: "card_account_closed",
      updatedAt: "2026-10-10T00:00:04.000Z",
    });
    await assert.rejects(repository.markRefunded(payment.id, LATER));
  });

  test(name("claimDue takes only PROCESSING and REFUND_PENDING payments whose next attempt has passed, oldest first up to the limit, leasing each and counting the attempt"), async () => {
    const { repository, seedBooking } = await setup();
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1_000).toISOString();
    const oldest = { ...newPayment(await seedBooking()), nextAttemptAt: at(10) };
    const due = { ...newPayment(await seedBooking()), nextAttemptAt: at(20) };
    const notYet = { ...newPayment(await seedBooking()), nextAttemptAt: at(60) };
    const refundPending = newPayment(await seedBooking());
    const finishedPayment = { ...newPayment(await seedBooking()), nextAttemptAt: at(5) };
    for (const payment of [oldest, due, notYet, refundPending, finishedPayment]) {
      await repository.start(payment);
    }
    await repository.markRefundPending(refundPending.id, "ch_r", new Date(at(30)));
    await repository.markSucceeded(finishedPayment.id, "ch_f", new Date(at(1)));
    const claimAt = new Date(at(30));
    const leasedUntil = at(70);

    const first = await repository.claimDue(claimAt, 40_000, 1);
    const rest = await repository.claimDue(claimAt, 40_000, 10);

    assert.deepEqual(
      first.map(({ id, attempts, nextAttemptAt }) => ({ id, attempts, nextAttemptAt })),
      [{ id: oldest.id, attempts: 1, nextAttemptAt: leasedUntil }],
    );
    assert.deepEqual(
      rest.map(({ id }) => id),
      [due.id, refundPending.id].sort(),
    );
    assert.equal(rest.find(({ id }) => id === refundPending.id)?.status, "REFUND_PENDING");
    assert.equal((await repository.findById(notYet.id))?.attempts, 0);
  });

  test(name("a claimed payment is not claimed again until its lease runs out"), async () => {
    const { repository, seedBooking } = await setup();
    const payment = newPayment(await seedBooking());
    await repository.start(payment);
    const claimAt = new Date(RECONCILE_AT);

    assert.equal((await repository.claimDue(claimAt, 40_000, 10)).length, 1);
    assert.deepEqual(await repository.claimDue(new Date(claimAt.getTime() + 39_999), 40_000, 10), []);
    const again = await repository.claimDue(new Date(claimAt.getTime() + 40_000), 40_000, 10);

    assert.deepEqual(again.map(({ id, attempts }) => ({ id, attempts })), [{ id: payment.id, attempts: 2 }]);
  });

  test(name("reschedule moves the next attempt and keeps the state; it throws once the payment has left that state"), async () => {
    const { repository, seedBooking } = await setup();
    const payment = newPayment(await seedBooking());
    await repository.start(payment);
    const retryAt = new Date("2026-10-10T00:05:00.000Z");

    await repository.reschedule(payment.id, "PROCESSING", retryAt);

    const stored = await repository.findById(payment.id);
    assert.equal(stored?.status, "PROCESSING");
    assert.equal(stored?.nextAttemptAt, retryAt.toISOString());
    await assert.rejects(repository.reschedule(payment.id, "REFUND_PENDING", retryAt));
    await repository.markFailed(payment.id, "card_declined", LATER);
    await assert.rejects(repository.reschedule(payment.id, "PROCESSING", retryAt));
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
