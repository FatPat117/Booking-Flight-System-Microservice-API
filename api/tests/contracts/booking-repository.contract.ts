import assert from "node:assert/strict";
import test from "node:test";

import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
} from "../../src/bookings/booking-repository.js";
import type { Flight } from "../../src/types.js";
import { FIXTURE_OTHER_AIRCRAFT_ID, makeFlight } from "../fixtures/flights.js";

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
 * Object-level authorization (Day 44) is part of the contract: a fake that
 * filters by owner while the Postgres adapter forgets to (e.g. in cancel()'s
 * follow-up read) would keep every use-case test green and ship a BOLA hole.
 *
 * Not a *.test.ts file: it registers tests only when a runner file calls it.
 */
export type BookingRepositoryContractSubject = Readonly<{
  repository: BookingRepository;
  /** Storage-specific seeding; the flight's shape stays in the contract. */
  insertFlight(flight: Flight): Promise<void>;
}>;

/** The clock every hold in this contract is made at (fixture flights depart in 2027). */
const NOW = new Date("2026-10-10T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function departingIn(ms: number): Pick<Flight, "departureAt" | "arrivalAt"> {
  const departure = NOW.getTime() + ms;
  return {
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + 2 * HOUR_MS).toISOString(),
  };
}

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const ADMIN: BookingAccessScope = { kind: "admin" };

function ownerScope(accountId: string): BookingAccessScope {
  return { kind: "owner", accountId };
}

function makeBooking(
  flightId: string,
  ownerAccountId: string = ACCOUNT_A,
  createdAt = "2026-07-20T00:00:00.000Z",
): Booking {
  return {
    id: crypto.randomUUID(),
    flightId,
    ownerAccountId,
    passengerName: "Alice",
    createdAt,
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
    overrides: Partial<Flight> = {},
  ): Promise<Flight> {
    const flight = makeFlight({ availableSeats, ...overrides });
    await subject.insertFlight(flight);
    return flight;
  }

  async function seedActiveBooking(
    subject: BookingRepositoryContractSubject,
    ownerAccountId: string = ACCOUNT_A,
    createdAt?: string,
  ): Promise<Booking> {
    const flight = await seedFlight(subject, 1);
    await subject.repository.reserveSeat(flight.id, NOW);
    const booking = makeBooking(flight.id, ownerAccountId, createdAt);
    await subject.repository.create(booking);
    return booking;
  }

  test(name("reserveSeat reserves until seats run out, then returns sold-out"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);

    assert.deepEqual(await subject.repository.reserveSeat(flight.id, NOW), { outcome: "reserved" });
    assert.deepEqual(await subject.repository.reserveSeat(flight.id, NOW), { outcome: "reserved" });
    assert.deepEqual(await subject.repository.reserveSeat(flight.id, NOW), { outcome: "sold-out" });
  });

  test(name("reserveSeat on an unknown flight returns flight-not-found, not sold-out"), async () => {
    const subject = await setup();

    assert.deepEqual(await subject.repository.reserveSeat(crypto.randomUUID(), NOW), {
      outcome: "flight-not-found",
    });
  });

  // Day 46, BR-FLT-06: the hold's WHERE clause (Postgres) and isBookable()
  // (fake) must agree, including at the one-hour boundary (ADR-008).
  test(name("reserveSeat on a flight not opened for sale is sales-closed and takes no seat"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1, { status: "SCHEDULED" });

    assert.deepEqual(await subject.repository.reserveSeat(flight.id, NOW), {
      outcome: "sales-closed",
    });
  });

  test(name("reserveSeat on a cancelled flight is sales-closed"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1, { status: "CANCELLED" });

    assert.deepEqual(await subject.repository.reserveSeat(flight.id, NOW), {
      outcome: "sales-closed",
    });
  });

  test(name("sales close exactly 1 hour before departure"), async () => {
    const subject = await setup();
    const atBoundary = await seedFlight(subject, 1, departingIn(HOUR_MS));
    // Another aircraft: the two windows overlap (BR-FLT-03).
    const justBefore = await seedFlight(subject, 1, {
      ...departingIn(HOUR_MS + 1000),
      aircraftId: FIXTURE_OTHER_AIRCRAFT_ID,
    });

    assert.deepEqual(await subject.repository.reserveSeat(atBoundary.id, NOW), {
      outcome: "sales-closed",
    });
    assert.deepEqual(await subject.repository.reserveSeat(justBefore.id, NOW), {
      outcome: "reserved",
    });
  });

  test(name("a sold-out open flight is sold-out, not sales-closed"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 0);

    assert.deepEqual(await subject.repository.reserveSeat(flight.id, NOW), {
      outcome: "sold-out",
    });
  });

  test(name("releaseSeat makes one more seat reservable on a sold-out flight"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1);
    await subject.repository.reserveSeat(flight.id, NOW);

    await subject.repository.releaseSeat(flight.id);

    assert.deepEqual(await subject.repository.reserveSeat(flight.id, NOW), { outcome: "reserved" });
    assert.deepEqual(await subject.repository.reserveSeat(flight.id, NOW), { outcome: "sold-out" });
  });

  test(name("cancel on an active booking returns cancelled with its flightId"), async () => {
    const subject = await setup();
    const booking = await seedActiveBooking(subject);

    assert.deepEqual(await subject.repository.cancel(booking.id, ownerScope(ACCOUNT_A)), {
      outcome: "cancelled",
      flightId: booking.flightId,
    });
  });

  test(name("cancelling the same booking twice returns already-cancelled"), async () => {
    const subject = await setup();
    const booking = await seedActiveBooking(subject);
    await subject.repository.cancel(booking.id, ownerScope(ACCOUNT_A));

    assert.deepEqual(await subject.repository.cancel(booking.id, ownerScope(ACCOUNT_A)), {
      outcome: "already-cancelled",
    });
  });

  test(name("cancel on an unknown booking returns not-found"), async () => {
    const subject = await setup();

    assert.deepEqual(await subject.repository.cancel(crypto.randomUUID(), ADMIN), {
      outcome: "not-found",
    });
  });

  test(name("create rejects a booking for an unknown flight"), async () => {
    const subject = await setup();

    await assert.rejects(() =>
      subject.repository.create(makeBooking(crypto.randomUUID())),
    );
  });

  test(name("findById returns the stored booking to its owner"), async () => {
    const subject = await setup();
    const booking = await seedActiveBooking(subject, ACCOUNT_A);

    assert.deepEqual(await subject.repository.findById(booking.id, ownerScope(ACCOUNT_A)), booking);
  });

  test(name("findById hides another account's booking (BR-AUTH-02)"), async () => {
    const subject = await setup();
    const bookingOfB = await seedActiveBooking(subject, ACCOUNT_B);

    assert.equal(await subject.repository.findById(bookingOfB.id, ownerScope(ACCOUNT_A)), undefined);
  });

  test(name("findById with the admin scope sees any account's booking"), async () => {
    const subject = await setup();
    const bookingOfB = await seedActiveBooking(subject, ACCOUNT_B);

    assert.deepEqual(await subject.repository.findById(bookingOfB.id, ADMIN), bookingOfB);
  });

  test(name("cancel of another account's active booking is not-found and leaves it active"), async () => {
    const subject = await setup();
    const bookingOfB = await seedActiveBooking(subject, ACCOUNT_B);

    assert.deepEqual(await subject.repository.cancel(bookingOfB.id, ownerScope(ACCOUNT_A)), {
      outcome: "not-found",
    });
    assert.equal((await subject.repository.findById(bookingOfB.id, ADMIN))?.status, "active");
  });

  test(name("cancel of another account's already-cancelled booking is not-found, not already-cancelled"), async () => {
    const subject = await setup();
    const bookingOfB = await seedActiveBooking(subject, ACCOUNT_B);
    await subject.repository.cancel(bookingOfB.id, ownerScope(ACCOUNT_B));

    assert.deepEqual(await subject.repository.cancel(bookingOfB.id, ownerScope(ACCOUNT_A)), {
      outcome: "not-found",
    });
  });

  test(name("findPage with an owner scope returns only that account's bookings, newest first"), async () => {
    const subject = await setup();
    const olderOfA = await seedActiveBooking(subject, ACCOUNT_A, "2026-07-20T00:00:00.000Z");
    await seedActiveBooking(subject, ACCOUNT_B, "2026-07-21T00:00:00.000Z");
    const newerOfA = await seedActiveBooking(subject, ACCOUNT_A, "2026-07-22T00:00:00.000Z");

    const page = await subject.repository.findPage(ownerScope(ACCOUNT_A), { limit: 10, offset: 0 });

    assert.deepEqual(page.items.map((b) => b.id), [newerOfA.id, olderOfA.id]);
    assert.equal(page.totalItems, 2);
  });

  test(name("findPage applies limit/offset after the scope; totalItems counts the whole scope"), async () => {
    const subject = await setup();
    await seedActiveBooking(subject, ACCOUNT_A, "2026-07-20T00:00:00.000Z");
    const middle = await seedActiveBooking(subject, ACCOUNT_A, "2026-07-21T00:00:00.000Z");
    await seedActiveBooking(subject, ACCOUNT_A, "2026-07-22T00:00:00.000Z");
    await seedActiveBooking(subject, ACCOUNT_B, "2026-07-23T00:00:00.000Z");

    const page = await subject.repository.findPage(ownerScope(ACCOUNT_A), { limit: 1, offset: 1 });

    assert.deepEqual(page.items.map((b) => b.id), [middle.id]);
    assert.equal(page.totalItems, 3);
  });

  test(name("findPage with the admin scope returns every account's bookings"), async () => {
    const subject = await setup();
    await seedActiveBooking(subject, ACCOUNT_A, "2026-07-20T00:00:00.000Z");
    await seedActiveBooking(subject, ACCOUNT_B, "2026-07-21T00:00:00.000Z");

    const page = await subject.repository.findPage(ADMIN, { limit: 10, offset: 0 });

    assert.equal(page.totalItems, 2);
  });
}
