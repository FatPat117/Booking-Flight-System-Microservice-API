import assert from "node:assert/strict";
import test from "node:test";

import type { BookingCancelledEvent } from "@booking-flight-system/contracts";

import type { BookingRepository } from "../src/bookings/booking-repository.js";
import { createCancelBookingInTransaction } from "../src/bookings/cancel-booking.js";
import {
  createCascadeFlightCancellations,
  FLIGHT_CANCELLATION_ACTOR,
} from "../src/bookings/cascade-flight-cancellations.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import type { Flight } from "../src/types.js";
import { makeBooking, passengersFor } from "./fixtures/bookings.js";
import { makeFlight } from "./fixtures/flights.js";
import {
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryPaymentRepository,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const VALID_UNTIL = new Date(NOW.getTime() + 15 * 60 * 1000);

function departingIn(ms: number): Pick<Flight, "departureAt" | "arrivalAt"> {
  const departure = NOW.getTime() + ms;
  return {
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + 2 * HOUR_MS).toISOString(),
  };
}

function runtime(
  options: { maxPerRun?: number; wrap?: (inner: BookingRepository) => BookingRepository } = {},
) {
  const store = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(store);
  const inner = createInMemoryBookingRepository({ flights: store });
  const bookingRepository = options.wrap?.(inner) ?? inner;
  const paymentRepository = createInMemoryPaymentRepository();
  const audit = createInMemoryAuditRecorder();
  const transactionRunner = createInMemoryTransactionRunner();
  const events: OutboxEntry[] = [];
  const outboxRepository: OutboxRepository = {
    async enqueue(entry) {
      events.push(entry);
    },
    async findUnpublished() {
      return [];
    },
    async markPublished() {},
  };

  const cascade = createCascadeFlightCancellations({
    bookingRepository,
    transactionRunner,
    cancelBookingInTransaction: createCancelBookingInTransaction({
      bookingRepository,
      paymentRepository,
      auditRecorder: audit,
      outboxRepository,
      generateAuditId: () => crypto.randomUUID(),
      generateOutboxId: () => crypto.randomUUID(),
      getRequestId: () => undefined,
    }),
    getCurrentTime: () => NOW,
    maxPerRun: options.maxPerRun ?? 100,
  });

  /** A HELD booking of one ECONOMY seat whose hold lapses at `until`. */
  async function hold(flight: Flight, until: Date = VALID_UNTIL): Promise<string> {
    const booking = makeBooking({ flightId: flight.id, holdExpiresAt: until.toISOString() });
    await transactionRunner.run(async () => {
      const held = await inner.holdSeats(
        flight.id,
        booking.id,
        { kind: "auto", count: 1, fareClass: "ECONOMY" },
        NOW,
      );
      assert.equal(held.outcome, "held");
      if (held.outcome !== "held") return;
      await inner.create({ ...booking, passengers: passengersFor(held.seats) });
    });
    return booking.id;
  }

  async function confirmed(flight: Flight): Promise<string> {
    const id = await hold(flight);
    assert.equal((await inner.confirmHold(id, { kind: "admin" }, NOW)).outcome, "confirmed");
    return id;
  }

  /** A payment for the booking, left PROCESSING or moved to SUCCEEDED. */
  async function payment(bookingId: string, status: "PROCESSING" | "SUCCEEDED"): Promise<string> {
    const booking = inner.peek(bookingId);
    assert.ok(booking);
    const id = crypto.randomUUID();
    await paymentRepository.start({
      id,
      bookingId,
      accountId: booking.ownerAccountId,
      amount: booking.total,
      paymentMethodToken: "tok_success",
      nextAttemptAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    });
    if (status === "SUCCEEDED") {
      await paymentRepository.markSucceeded(id, `sim_${id}`, NOW);
    }
    return id;
  }

  async function cancelFlight(flight: Flight): Promise<void> {
    assert.equal((await flightRepository.changeStatus(flight.id, flight.status, "CANCELLED")).outcome, "changed");
  }

  async function newFlight(overrides: Partial<Flight> = {}): Promise<Flight> {
    const flight = makeFlight({ availableSeats: 6, ...departingIn(48 * HOUR_MS), ...overrides });
    assert.deepEqual(await flightRepository.create(flight), { outcome: "created" });
    return flight;
  }

  return {
    store, inner, paymentRepository, audit, events, cascade,
    hold, confirmed, payment, cancelFlight, newFlight,
  };
}

test("the cascade cancels a HELD, a paid CONFIRMED and a CONFIRMED with a PROCESSING payment on a cancelled flight, for the airline", async () => {
  const r = runtime();
  const flight = await r.newFlight();
  const held = await r.hold(flight);
  const paid = await r.confirmed(flight);
  const paidPayment = await r.payment(paid, "SUCCEEDED");
  // An older payment still at the gateway when the flight was cancelled.
  const pending = await r.confirmed(flight);
  const pendingPayment = await r.payment(pending, "PROCESSING");
  await r.cancelFlight(flight);

  const result = await r.cascade();

  assert.deepEqual(result, { cancelled: 3, refundsStarted: 1, exhausted: false });
  for (const id of [held, paid, pending]) {
    const booking = r.inner.peek(id);
    assert.equal(booking?.status, "CANCELLED");
    assert.equal(booking?.cancellationReason, "AIRLINE");
  }
  assert.ok(
    (r.store.seats.get(flight.id) ?? []).every((seat) => seat.status === "AVAILABLE" && seat.bookingId === null),
    "every seat of the flight is free again",
  );
  // The paid one is on its way back; the PROCESSING one is reconciliation's
  // (its charge, if it lands, finds the booking cancelled and is refunded).
  assert.equal((await r.paymentRepository.findById(paidPayment))?.status, "REFUND_PENDING");
  assert.equal((await r.paymentRepository.findById(pendingPayment))?.status, "PROCESSING");
});

test("each cascaded booking gets one BOOKING_CANCELLED by the system actor with reason AIRLINE, and the paid one a PAYMENT_REFUND_PENDING", async () => {
  const r = runtime();
  const flight = await r.newFlight();
  await r.hold(flight);
  const paid = await r.confirmed(flight);
  await r.payment(paid, "SUCCEEDED");
  await r.cancelFlight(flight);

  await r.cascade();

  const cancelled = r.audit.records.filter((record) => record.action === "BOOKING_CANCELLED");
  assert.equal(cancelled.length, 2);
  for (const record of cancelled) {
    assert.deepEqual(record.actor, FLIGHT_CANCELLATION_ACTOR);
    assert.equal(record.metadata.reason, "AIRLINE");
    assert.equal(record.requestId, undefined);
  }
  const refunds = r.audit.records.filter((record) => record.action === "PAYMENT_REFUND_PENDING");
  assert.equal(refunds.length, 1);
  assert.deepEqual(refunds[0]?.actor, FLIGHT_CANCELLATION_ACTOR);
  assert.equal(refunds[0]?.metadata.cancellationReason, "AIRLINE");
});

test("each cascaded booking gets one booking-cancelled event with reason AIRLINE, the paid one with its refund", async () => {
  const r = runtime();
  const flight = await r.newFlight();
  const held = await r.hold(flight);
  const paid = await r.confirmed(flight);
  const paymentId = await r.payment(paid, "SUCCEEDED");
  await r.cancelFlight(flight);

  await r.cascade();

  const byBooking = new Map(
    r.events.map((entry) => {
      const event = entry.payload as BookingCancelledEvent;
      return [event.booking.id, event];
    }),
  );
  assert.equal(r.events.length, 2);
  assert.ok(r.events.every((entry) => entry.eventType === "booking-cancelled"));
  assert.equal(byBooking.get(held)?.reason, "AIRLINE");
  assert.equal(byBooking.get(held)?.refund, null);
  assert.equal(byBooking.get(paid)?.reason, "AIRLINE");
  assert.equal(byBooking.get(paid)?.refund?.paymentId, paymentId);
});

test("the 24 h window does not stop the cascade: a CONFIRMED booking 2 h before departure is cancelled (BR-FLT-07)", async () => {
  const r = runtime();
  const flight = await r.newFlight(departingIn(2 * HOUR_MS));
  const booking = await r.confirmed(flight);
  await r.cancelFlight(flight);

  assert.equal((await r.cascade()).cancelled, 1);
  assert.equal(r.inner.peek(booking)?.status, "CANCELLED");
});

test("the cascade leaves alone a lapsed hold, an already cancelled booking and every booking of a flight that is not cancelled", async () => {
  const r = runtime();
  const cancelledFlight = await r.newFlight();
  // A day later: the same fixture aircraft cannot fly both at once (BR-FLT-08).
  const openFlight = await r.newFlight(departingIn(72 * HOUR_MS));
  const lapsed = await r.hold(cancelledFlight, NOW);
  const byOwner = await r.hold(cancelledFlight);
  assert.equal(
    (await r.inner.cancel(byOwner, { kind: "admin" }, NOW, "CUSTOMER")).outcome,
    "cancelled",
  );
  const onOpenFlight = await r.confirmed(openFlight);
  await r.cancelFlight(cancelledFlight);

  assert.deepEqual(await r.cascade(), { cancelled: 0, refundsStarted: 0, exhausted: false });
  assert.equal(r.inner.peek(lapsed)?.status, "HELD");
  assert.equal(r.inner.peek(byOwner)?.cancellationReason, "CUSTOMER");
  assert.equal(r.inner.peek(onOpenFlight)?.status, "CONFIRMED");
  assert.equal(r.events.length, 0);
});

test("a run stops at maxPerRun and says so; the next run cancels the rest; a run with nothing left is a no-op", async () => {
  const r = runtime({ maxPerRun: 2 });
  const flight = await r.newFlight();
  for (let i = 0; i < 3; i += 1) {
    await r.hold(flight);
  }
  await r.cancelFlight(flight);

  assert.deepEqual(await r.cascade(), { cancelled: 2, refundsStarted: 0, exhausted: true });
  assert.deepEqual(await r.cascade(), { cancelled: 1, refundsStarted: 0, exhausted: false });
  assert.deepEqual(await r.cascade(), { cancelled: 0, refundsStarted: 0, exhausted: false });
  assert.equal(r.events.length, 3);
});

test("a claimed booking the AIRLINE cancel does not take is a bug: the run throws instead of skipping it", async () => {
  const strayId = crypto.randomUUID();
  const r = runtime({
    wrap: (inner) => ({ ...inner, claimLiveBookingOfCancelledFlight: async () => strayId }),
  });

  await assert.rejects(r.cascade(), /was not cancelled: not-found/);
});
