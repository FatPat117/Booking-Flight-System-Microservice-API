import assert from "node:assert/strict";
import test from "node:test";

import type {
  Booking,
  BookingRepository,
} from "../../src/bookings/booking-repository.js";
import type { Flight } from "../../src/types.js";

/**
 * What every BookingRepository promises, run against every implementation
 * (Day 41): the in-memory fake in the unit tier, Postgres in the integration
 * tier. If the fake drifts from the real adapter, the same assertion passes
 * on one side and fails on the other.
 *
 * Sequential behavior only. Concurrency (OCC under real parallel writers) is
 * not part of this contract — a single-threaded fake cannot fail it, so it
 * lives in postgres-booking-race.integration.test.ts alone.
 *
 * Not a *.test.ts file: it registers tests only when a runner file calls it.
 */
export type BookingRepositoryContractSubject = Readonly<{
  repository: BookingRepository;
  /** Storage-specific seeding; the flight's shape stays in the contract. */
  insertFlight(flight: Flight): Promise<void>;
}>;

let flightSequence = 0;

function makeFlight(availableSeats: number): Flight {
  flightSequence += 1;
  return {
    id: crypto.randomUUID(),
    flightNumber: `CT${String(flightSequence).padStart(3, "0")}`,
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T01:00:00.000Z",
    arrivalAt: "2026-08-10T03:00:00.000Z",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats,
  };
}

function makeBooking(flightId: string): Booking {
  return {
    id: crypto.randomUUID(),
    flightId,
    passengerName: "Alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "active",
  };
}

export function runBookingRepositoryContract(
  implementation: string,
  setup: () => Promise<BookingRepositoryContractSubject>,
): void {
  const name = (behavior: string) =>
    `BookingRepository contract (${implementation}): ${behavior}`;

  async function seedFlight(
    subject: BookingRepositoryContractSubject,
    availableSeats: number,
  ): Promise<Flight> {
    const flight = makeFlight(availableSeats);
    await subject.insertFlight(flight);
    return flight;
  }

  async function seedActiveBooking(
    subject: BookingRepositoryContractSubject,
  ): Promise<Booking> {
    const flight = await seedFlight(subject, 1);
    await subject.repository.reserveSeat(flight.id);
    const booking = makeBooking(flight.id);
    await subject.repository.create(booking);
    return booking;
  }

  test(name("reserveSeat reserves until seats run out, then returns sold-out"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);

    assert.deepEqual(await subject.repository.reserveSeat(flight.id), { outcome: "reserved" });
    assert.deepEqual(await subject.repository.reserveSeat(flight.id), { outcome: "reserved" });
    assert.deepEqual(await subject.repository.reserveSeat(flight.id), { outcome: "sold-out" });
  });

  test(name("reserveSeat on an unknown flight returns flight-not-found, not sold-out"), async () => {
    const subject = await setup();

    assert.deepEqual(await subject.repository.reserveSeat(crypto.randomUUID()), {
      outcome: "flight-not-found",
    });
  });

  test(name("releaseSeat makes one more seat reservable on a sold-out flight"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1);
    await subject.repository.reserveSeat(flight.id);

    await subject.repository.releaseSeat(flight.id);

    assert.deepEqual(await subject.repository.reserveSeat(flight.id), { outcome: "reserved" });
    assert.deepEqual(await subject.repository.reserveSeat(flight.id), { outcome: "sold-out" });
  });

  test(name("cancel on an active booking returns cancelled with its flightId"), async () => {
    const subject = await setup();
    const booking = await seedActiveBooking(subject);

    assert.deepEqual(await subject.repository.cancel(booking.id), {
      outcome: "cancelled",
      flightId: booking.flightId,
    });
  });

  test(name("cancelling the same booking twice returns already-cancelled"), async () => {
    const subject = await setup();
    const booking = await seedActiveBooking(subject);
    await subject.repository.cancel(booking.id);

    assert.deepEqual(await subject.repository.cancel(booking.id), {
      outcome: "already-cancelled",
    });
  });

  test(name("cancel on an unknown booking returns not-found"), async () => {
    const subject = await setup();

    assert.deepEqual(await subject.repository.cancel(crypto.randomUUID()), {
      outcome: "not-found",
    });
  });

  test(name("create rejects a booking for an unknown flight"), async () => {
    const subject = await setup();

    await assert.rejects(() =>
      subject.repository.create(makeBooking(crypto.randomUUID())),
    );
  });
}
