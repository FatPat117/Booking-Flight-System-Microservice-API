import assert from "node:assert/strict";
import test from "node:test";

import { parseBookingExpiredEvent } from "@booking-flight-system/contracts";
import type { AuditRecorder } from "../src/audit/audit-recorder.js";
import type { Booking } from "../src/bookings/booking-repository.js";
import {
  BOOKING_EXPIRED_QUEUE,
  createExpireHolds,
  HOLD_EXPIRY_ACTOR,
} from "../src/bookings/expire-holds.js";
import {
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryOutboxRepository,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";
import { makeBooking } from "./fixtures/bookings.js";
import { makeFlight } from "./fixtures/flights.js";

/** When the holds were made; fixture flights depart in 2027. */
const HELD_AT = new Date("2026-07-20T00:00:00.000Z");
const HOLD_MS = 15 * 60 * 1000;
const DEADLINE = new Date(HELD_AT.getTime() + HOLD_MS);

async function createRuntime(options: { batchSize?: number; maxBatches?: number } = {}) {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const auditRecorder = createInMemoryAuditRecorder();
  const outboxRepository = createInMemoryOutboxRepository();
  const flight = makeFlight({ availableSeats: 12 });
  await flightRepository.create(flight);

  let clock = DEADLINE;
  let clockReads = 0;
  let afterClockRead: (() => void) | undefined;
  let auditIds = 0;
  let outboxIds = 0;

  const expireHolds = createExpireHolds({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner: createInMemoryTransactionRunner(),
    generateAuditId: () => `audit-${(auditIds += 1)}`,
    generateOutboxId: () => `event-${(outboxIds += 1)}`,
    getCurrentTime: () => {
      clockReads += 1;
      const read = clock;
      afterClockRead?.();
      return read;
    },
    batchSize: options.batchSize ?? 50,
    maxBatches: options.maxBatches ?? 20,
  });

  /** A HELD booking of `seats` auto seats, lapsing at `holdExpiresAt`. */
  async function seedHold(seats = 1, holdExpiresAt = DEADLINE): Promise<Booking> {
    const booking = makeBooking({
      flightId: flight.id,
      holdExpiresAt: holdExpiresAt.toISOString(),
    });
    const held = await bookingRepository.holdSeats(
      flight.id,
      booking.id,
      { kind: "auto", count: seats },
      HELD_AT,
    );
    assert.equal(held.outcome, "held");
    const stored = {
      ...booking,
      passengers: held.outcome === "held"
        ? held.seats.map((seat, index) => ({ name: `Passenger ${index + 1}`, seat }))
        : [],
    };
    assert.deepEqual(await bookingRepository.create(stored), { outcome: "created" });
    return stored;
  }

  return {
    flight,
    flightRepository,
    bookingRepository,
    auditRecorder,
    outboxRepository,
    expireHolds,
    seedHold,
    setClock: (next: Date) => {
      clock = next;
    },
    /** Moves time on as soon as the use case has read it. */
    advanceClockAfterRead: (next: Date) => {
      afterClockRead = () => {
        clock = next;
      };
    },
    clockReads: () => clockReads,
  };
}

test("a hold at its deadline becomes EXPIRED, frees its seats, and records one system audit entry and one booking-expired event", async () => {
  const runtime = await createRuntime();
  const booking = await runtime.seedHold(2);

  assert.deepEqual(await runtime.expireHolds(), { expired: 1, batches: 1, exhausted: false });

  assert.equal(runtime.bookingRepository.peek(booking.id)?.status, "EXPIRED");
  assert.equal((await runtime.flightRepository.findById(runtime.flight.id))?.availableSeats, 12);

  assert.deepEqual(runtime.auditRecorder.records, [
    {
      id: "audit-1",
      action: "BOOKING_EXPIRED",
      actor: { type: "system", id: "booking-hold-expiry" },
      target: { type: "booking", id: booking.id },
      occurredAt: DEADLINE.toISOString(),
      metadata: {
        flightId: runtime.flight.id,
        reference: booking.reference,
        seats: "1A,1B",
        holdExpiresAt: DEADLINE.toISOString(),
        correlationId: "event-1",
      },
    },
  ]);
  assert.deepEqual(HOLD_EXPIRY_ACTOR, { type: "system", id: "booking-hold-expiry" });

  const [entry] = runtime.outboxRepository.entries;
  assert.equal(runtime.outboxRepository.entries.length, 1);
  assert.equal(entry?.eventType, BOOKING_EXPIRED_QUEUE);
  // The event is checked by the parser the notifier uses, not only by shape.
  assert.deepEqual(parseBookingExpiredEvent(entry?.payload), {
    ok: true,
    event: {
      eventId: "event-1",
      correlationId: "event-1",
      type: "booking.expired",
      occurredAt: DEADLINE.toISOString(),
      booking: {
        id: booking.id,
        reference: booking.reference,
        flightId: runtime.flight.id,
        holdExpiresAt: DEADLINE.toISOString(),
        seats: ["1A", "1B"],
      },
    },
  });
});

test("a hold still valid 1 ms before its deadline is untouched and nothing is recorded", async () => {
  const runtime = await createRuntime();
  const booking = await runtime.seedHold();
  runtime.setClock(new Date(DEADLINE.getTime() - 1));

  assert.deepEqual(await runtime.expireHolds(), { expired: 0, batches: 1, exhausted: false });

  assert.equal(runtime.bookingRepository.peek(booking.id)?.status, "HELD");
  assert.equal(runtime.auditRecorder.records.length, 0);
  assert.equal(runtime.outboxRepository.entries.length, 0);
});

test("batches run until one comes back short: 5 due in batches of 2 is 2 + 2 + 1", async () => {
  const runtime = await createRuntime({ batchSize: 2 });
  for (let i = 0; i < 5; i += 1) {
    await runtime.seedHold();
  }

  assert.deepEqual(await runtime.expireHolds(), { expired: 5, batches: 3, exhausted: false });
  assert.equal(runtime.auditRecorder.records.length, 5);
  assert.equal(runtime.outboxRepository.entries.length, 5);
});

test("a run stops at maxBatches and says so; the next run expires the rest", async () => {
  const runtime = await createRuntime({ batchSize: 2, maxBatches: 2 });
  for (let i = 0; i < 5; i += 1) {
    await runtime.seedHold();
  }

  assert.deepEqual(await runtime.expireHolds(), { expired: 4, batches: 2, exhausted: true });
  assert.deepEqual(await runtime.expireHolds(), { expired: 1, batches: 1, exhausted: false });
  assert.deepEqual(await runtime.expireHolds(), { expired: 0, batches: 1, exhausted: false });
});

test("now is read once per run: a hold lapsing during the run waits for the next one", async () => {
  const runtime = await createRuntime({ batchSize: 1 });
  await runtime.seedHold();
  const lapsesDuringRun = new Date(DEADLINE.getTime() + 1);
  const later = await runtime.seedHold(1, lapsesDuringRun);
  // The run reads DEADLINE; any read after that would see the later hold due.
  runtime.advanceClockAfterRead(lapsesDuringRun);

  // A full batch of 1, then an empty one: the run ends there.
  assert.deepEqual(await runtime.expireHolds(), { expired: 1, batches: 2, exhausted: false });
  assert.equal(runtime.clockReads(), 1);
  assert.equal(runtime.bookingRepository.peek(later.id)?.status, "HELD");

  assert.deepEqual(await runtime.expireHolds(), { expired: 1, batches: 2, exhausted: false });
  assert.equal(runtime.bookingRepository.peek(later.id)?.status, "EXPIRED");
});

test("an audit failure is not swallowed: the run rejects", async () => {
  const runtime = await createRuntime();
  await runtime.seedHold();
  const failingAudit: AuditRecorder = {
    async record() {
      throw new Error("audit store down");
    },
  };
  const expireHolds = createExpireHolds({
    bookingRepository: runtime.bookingRepository,
    auditRecorder: failingAudit,
    outboxRepository: runtime.outboxRepository,
    transactionRunner: createInMemoryTransactionRunner(),
    generateAuditId: () => "audit-1",
    generateOutboxId: () => "event-1",
    getCurrentTime: () => DEADLINE,
    batchSize: 50,
    maxBatches: 20,
  });

  // Rolling the batch back is database semantics, proven on Postgres
  // (postgres-booking-expiry-race.integration.test.ts), not on this fake.
  await assert.rejects(() => expireHolds(), /audit store down/);
});
