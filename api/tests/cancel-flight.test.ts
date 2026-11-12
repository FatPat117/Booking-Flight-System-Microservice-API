import assert from "node:assert/strict";
import test from "node:test";

import { createCancelFlight } from "../src/flights/cancel-flight.js";
import type { FlightRepository } from "../src/flights/flight-repository.js";
import type { Flight } from "../src/types.js";
import { makeBooking, passengersFor } from "./fixtures/bookings.js";
import { makeFlight } from "./fixtures/flights.js";
import {
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const ADMIN = { accountId: "aaaaaaaa-0000-4000-8000-000000000001" };

function departingIn(ms: number): Pick<Flight, "departureAt" | "arrivalAt"> {
  const departure = NOW.getTime() + ms;
  return {
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + 2 * HOUR_MS).toISOString(),
  };
}

function runtime(wrap: (inner: FlightRepository) => FlightRepository = (inner) => inner) {
  const store = createInMemoryFlightStore();
  const inner = createInMemoryFlightRepository(store);
  const flightRepository = wrap(inner);
  const bookingRepository = createInMemoryBookingRepository({ flights: store });
  const audit = createInMemoryAuditRecorder();
  const transactionRunner = createInMemoryTransactionRunner();
  const cancelFlight = createCancelFlight({
    flightRepository,
    bookingRepository,
    auditRecorder: audit,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => "req-1",
    getCurrentTime: () => NOW,
  });

  /** A HELD booking on the flight whose hold lapses at `holdExpiresAt`. */
  async function hold(flight: Flight, holdExpiresAt: Date): Promise<string> {
    const booking = makeBooking({ flightId: flight.id, holdExpiresAt: holdExpiresAt.toISOString() });
    await transactionRunner.run(async () => {
      const held = await bookingRepository.holdSeats(
        flight.id,
        booking.id,
        { kind: "auto", count: 1, fareClass: "ECONOMY" },
        NOW,
      );
      assert.equal(held.outcome, "held");
      if (held.outcome !== "held") return;
      await bookingRepository.create({ ...booking, passengers: passengersFor(held.seats) });
    });
    return booking.id;
  }

  return { inner, flightRepository, bookingRepository, audit, cancelFlight, hold };
}

const cancellations = (audit: ReturnType<typeof createInMemoryAuditRecorder>) =>
  audit.records.filter((record) => record.action === "FLIGHT_CANCELLED");

// Every effective status a flight can be in, from the stored one and the clock.
const SOURCES: ReadonlyArray<{
  name: string;
  flight: Partial<Flight>;
  expected: "cancelled" | "already-cancelled" | "invalid-status";
}> = [
  { name: "SCHEDULED", flight: { status: "SCHEDULED", ...departingIn(48 * HOUR_MS) }, expected: "cancelled" },
  { name: "OPEN", flight: { status: "OPEN", ...departingIn(48 * HOUR_MS) }, expected: "cancelled" },
  // Stored OPEN, 30 minutes before departure: sales closed, not departed.
  { name: "CLOSED", flight: { status: "OPEN", ...departingIn(30 * 60 * 1000) }, expected: "cancelled" },
  { name: "DEPARTED", flight: { status: "OPEN", ...departingIn(-HOUR_MS) }, expected: "invalid-status" },
  { name: "CANCELLED", flight: { status: "CANCELLED", ...departingIn(48 * HOUR_MS) }, expected: "already-cancelled" },
];

for (const source of SOURCES) {
  test(`cancelling a ${source.name} flight is ${source.expected}`, async () => {
    const { inner, cancelFlight, audit } = runtime();
    const flight = makeFlight(source.flight);
    await inner.create(flight);

    const result = await cancelFlight(flight.id, ADMIN);

    assert.equal(result.outcome, source.expected);
    const stored = await inner.findById(flight.id);
    assert.equal(stored?.status, source.expected === "invalid-status" ? flight.status : "CANCELLED");
    assert.equal(cancellations(audit).length, source.expected === "cancelled" ? 1 : 0);
  });
}

test("a departed flight is refused with its effective status and NOT_ALLOWED", async () => {
  const { inner, cancelFlight } = runtime();
  const flight = makeFlight({ status: "OPEN", ...departingIn(-HOUR_MS) });
  await inner.create(flight);

  assert.deepEqual(await cancelFlight(flight.id, ADMIN), {
    outcome: "invalid-status",
    currentStatus: "DEPARTED",
    reason: "NOT_ALLOWED",
  });
});

test("cancelling audits the admin, the flight and its effective previous status (CLOSED, not the stored OPEN)", async () => {
  const { inner, cancelFlight, audit } = runtime();
  const flight = makeFlight({ status: "OPEN", ...departingIn(30 * 60 * 1000) });
  await inner.create(flight);

  await cancelFlight(flight.id, ADMIN);

  const [record] = cancellations(audit);
  assert.ok(record);
  assert.deepEqual(record.actor, { type: "account", id: ADMIN.accountId });
  assert.deepEqual(record.target, { type: "flight", id: flight.id });
  assert.equal(record.requestId, "req-1");
  assert.equal(record.occurredAt, NOW.toISOString());
  assert.deepEqual(record.metadata, { flightNumber: flight.flightNumber, previousStatus: "CLOSED" });
});

test("cancelling changes only the flight: its bookings stay as they are and are reported as remaining", async () => {
  const { inner, bookingRepository, cancelFlight, hold } = runtime();
  const flight = makeFlight({ ...departingIn(48 * HOUR_MS) });
  await inner.create(flight);
  const valid = new Date(NOW.getTime() + 15 * 60 * 1000);
  const first = await hold(flight, valid);
  const second = await hold(flight, valid);
  await hold(flight, NOW); // lapsed at NOW: the expiry job's, not counted

  const result = await cancelFlight(flight.id, ADMIN);

  assert.equal(result.outcome, "cancelled");
  assert.ok(result.outcome === "cancelled");
  assert.equal(result.remainingBookings, 2);
  assert.equal(result.flight.status, "CANCELLED");
  for (const id of [first, second]) {
    assert.equal(bookingRepository.peek(id)?.status, "HELD");
  }
});

test("cancelling again answers already-cancelled with the current remaining count and writes no second audit", async () => {
  const { inner, cancelFlight, audit, hold } = runtime();
  const flight = makeFlight({ ...departingIn(48 * HOUR_MS) });
  await inner.create(flight);
  await hold(flight, new Date(NOW.getTime() + 15 * 60 * 1000));

  assert.equal((await cancelFlight(flight.id, ADMIN)).outcome, "cancelled");
  const again = await cancelFlight(flight.id, ADMIN);

  assert.equal(again.outcome, "already-cancelled");
  assert.ok(again.outcome === "already-cancelled");
  assert.equal(again.remainingBookings, 1);
  assert.equal(cancellations(audit).length, 1);
});

test("losing the compare-and-set to another cancel is already-cancelled, with no audit of its own", async () => {
  const { inner, cancelFlight, audit } = runtime((repository) => ({
    ...repository,
    async changeStatus(flightId, expected, next) {
      await repository.changeStatus(flightId, expected, "CANCELLED");
      return repository.changeStatus(flightId, expected, next);
    },
  }));
  const flight = makeFlight({ ...departingIn(48 * HOUR_MS) });
  await inner.create(flight);

  const result = await cancelFlight(flight.id, ADMIN);

  assert.equal(result.outcome, "already-cancelled");
  assert.equal(cancellations(audit).length, 0);
});

test("losing the compare-and-set to an open is status-changed, and the flight stays OPEN", async () => {
  const { inner, cancelFlight, audit } = runtime((repository) => ({
    ...repository,
    async changeStatus(flightId, expected, next) {
      await repository.changeStatus(flightId, "SCHEDULED", "OPEN");
      return repository.changeStatus(flightId, expected, next);
    },
  }));
  const flight = makeFlight({ status: "SCHEDULED", ...departingIn(48 * HOUR_MS) });
  await inner.create(flight);

  assert.deepEqual(await cancelFlight(flight.id, ADMIN), {
    outcome: "status-changed",
    currentStatus: "OPEN",
  });
  assert.equal((await inner.findById(flight.id))?.status, "OPEN");
  assert.equal(cancellations(audit).length, 0);
});

test("an unknown or malformed flight id is not-found", async () => {
  const { cancelFlight } = runtime();

  assert.deepEqual(await cancelFlight(crypto.randomUUID(), ADMIN), { outcome: "not-found" });
  assert.deepEqual(await cancelFlight("not-a-uuid", ADMIN), { outcome: "not-found" });
});
