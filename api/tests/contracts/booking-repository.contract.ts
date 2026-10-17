import assert from "node:assert/strict";
import test from "node:test";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
  HoldSeatsResult,
  SeatHoldRequest,
} from "../../src/bookings/booking-repository.js";
import type { Flight } from "../../src/types.js";
import {
  FIXTURE_ACCOUNT_A as ACCOUNT_A,
  FIXTURE_ACCOUNT_B as ACCOUNT_B,
  makeBooking as makeFixtureBooking,
} from "../fixtures/bookings.js";
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
  /**
   * Storage-specific seeding; the flight's shape stays in the contract. The
   * flight must end up with exactly `availableSeats` seats, the first ones
   * in (row, letter) order of a six-abreast ABCDEF layout.
   */
  insertFlight(flight: Flight): Promise<void>;
  /**
   * Runs `work` in one transaction. A claimed seat points at a booking that
   * is inserted right after it; Postgres checks that link at commit, so the
   * two must commit together — as they do inside CreateBooking.
   */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Every seat of the flight as stored, (row, letter) order — read past the
   * port, so "nothing was written" can be checked on both sides.
   */
  seats(flightId: string): Promise<StoredSeat[]>;
}>;

export type StoredSeat = Readonly<{
  seat: string;
  status: string;
  bookingId: string | null;
}>;

/** The clock every hold in this contract is made at (fixture flights depart in 2027). */
const NOW = new Date("2026-10-10T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
/**
 * The clock cancels run at: the fixture bookings' createdAt, before every
 * hold in this contract lapses (fixtures lapse 2026-07-20T00:15Z, the
 * expiry cases later still). The Day 48B cases move it on purpose.
 */
const CANCEL_AT = new Date("2026-07-20T00:00:00.000Z");

function departingIn(ms: number): Pick<Flight, "departureAt" | "arrivalAt"> {
  const departure = NOW.getTime() + ms;
  return {
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + 2 * HOUR_MS).toISOString(),
  };
}

const ADMIN: BookingAccessScope = { kind: "admin" };

function ownerScope(accountId: string): BookingAccessScope {
  return { kind: "owner", accountId };
}

function makeBooking(
  flightId: string,
  ownerAccountId: string = ACCOUNT_A,
  createdAt = "2026-07-20T00:00:00.000Z",
): Booking {
  return makeFixtureBooking({ flightId, ownerAccountId, createdAt });
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

  /** A HELD booking holding seat 1A of its own one-seat flight, as stored. */
  async function seedHeldBooking(
    subject: BookingRepositoryContractSubject,
    ownerAccountId: string = ACCOUNT_A,
    createdAt?: string,
  ): Promise<Booking> {
    const flight = await seedFlight(subject, 1);
    const booking = makeBooking(flight.id, ownerAccountId, createdAt);
    const held = await book(subject, booking);
    assert.equal(held.outcome, "held");
    return withSeats(booking, ["1A"]);
  }

  /** The held seats copied onto the passengers, one each, in order. */
  function withSeats(booking: Booking, seats: readonly string[]): Booking {
    return {
      ...booking,
      passengers: seats.map((seat, index) => ({
        name: booking.passengers[index]?.name ?? `Passenger ${index + 1}`,
        seat,
      })),
    };
  }

  function chosen(...codes: string[]): SeatHoldRequest {
    return {
      kind: "chosen",
      seats: codes.map((code) => {
        const position = parseSeatPosition(code);
        assert.ok(position, code);
        return position;
      }),
    };
  }

  /**
   * Seats first, then the booking they point at, in one transaction —
   * CreateBooking's order. The booking is stored only if its seats were
   * held, with them copied onto its passengers. Default: one auto seat.
   */
  function book(
    subject: BookingRepositoryContractSubject,
    booking: Booking,
    request: SeatHoldRequest = { kind: "auto", count: 1 },
  ): Promise<HoldSeatsResult> {
    return subject.transaction(async () => {
      const held = await subject.repository.holdSeats(booking.flightId, booking.id, request, NOW);
      if (held.outcome === "held") {
        const created = await subject.repository.create(withSeats(booking, held.seats));
        assert.deepEqual(created, { outcome: "created" });
      }
      return held;
    });
  }

  /** Seat code → status ("1A:HELD"), for compact "nothing changed" checks. */
  async function statuses(subject: BookingRepositoryContractSubject, flightId: string) {
    return (await subject.seats(flightId)).map((seat) => `${seat.seat}:${seat.status}`);
  }

  test(name("auto hold of one seat allocates lowest row then letter, returning each code, until none is left"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);

    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "held", seats: ["1A"] });
    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "held", seats: ["1B"] });
    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "not-enough-seats" });
  });

  test(name("holdSeats on an unknown flight returns flight-not-found, not not-enough-seats"), async () => {
    const subject = await setup();

    assert.deepEqual(await book(subject, makeBooking(crypto.randomUUID())), {
      outcome: "flight-not-found",
    });
  });

  // Day 46, BR-FLT-06: the hold's WHERE clause (Postgres) and isBookable()
  // (fake) must agree, including at the one-hour boundary (ADR-008).
  test(name("holdSeats on a flight not opened for sale is sales-closed and takes no seat"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1, { status: "SCHEDULED" });

    assert.deepEqual(await book(subject, makeBooking(flight.id)), {
      outcome: "sales-closed",
    });
  });

  test(name("holdSeats on a cancelled flight is sales-closed"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1, { status: "CANCELLED" });

    assert.deepEqual(await book(subject, makeBooking(flight.id)), {
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

    assert.deepEqual(await book(subject, makeBooking(atBoundary.id)), {
      outcome: "sales-closed",
    });
    assert.deepEqual(await book(subject, makeBooking(justBefore.id)), {
      outcome: "held",
      seats: ["1A"],
    });
  });

  test(name("a sold-out open flight is not-enough-seats, not sales-closed"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 0);

    assert.deepEqual(await book(subject, makeBooking(flight.id)), {
      outcome: "not-enough-seats",
    });
  });

  // ---- Day 48A: several seats, all or nothing (BR-SEAT-02) ----

  test(name("auto hold of 3 takes the 3 lowest free seats in order, all HELD for the booking"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 8);
    await book(subject, makeBooking(flight.id)); // 1A, so the next three skip it

    const booking = makeBooking(flight.id);
    assert.deepEqual(await book(subject, booking, { kind: "auto", count: 3 }), {
      outcome: "held",
      seats: ["1B", "1C", "1D"],
    });
    const stored = await subject.seats(flight.id);
    assert.deepEqual(
      stored.filter((seat) => seat.bookingId === booking.id).map((seat) => seat.seat),
      ["1B", "1C", "1D"],
    );
    assert.deepEqual(stored.map((seat) => seat.status), [
      "HELD", "HELD", "HELD", "HELD", "AVAILABLE", "AVAILABLE", "AVAILABLE", "AVAILABLE",
    ]);
  });

  test(name("auto hold of 3 with 2 seats left is not-enough-seats and changes no seat"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);
    const before = await statuses(subject, flight.id);

    assert.deepEqual(
      await book(subject, makeBooking(flight.id), { kind: "auto", count: 3 }),
      { outcome: "not-enough-seats" },
    );
    assert.deepEqual(await statuses(subject, flight.id), before);
    assert.deepEqual(before, ["1A:AVAILABLE", "1B:AVAILABLE"]);
  });

  test(name("chosen seats are held exactly, returned in the request's order"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 12);
    const booking = makeBooking(flight.id);

    assert.deepEqual(await book(subject, booking, chosen("2B", "1C")), {
      outcome: "held",
      seats: ["2B", "1C"],
    });
    assert.deepEqual(
      (await subject.seats(flight.id))
        .filter((seat) => seat.bookingId === booking.id)
        .map((seat) => `${seat.seat}:${seat.status}`),
      ["1C:HELD", "2B:HELD"],
    );
  });

  test(name("chosen seats with one already held: seats-unavailable names only that one, the other stays AVAILABLE"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 6);
    await book(subject, makeBooking(flight.id), chosen("1B"));

    assert.deepEqual(
      await book(subject, makeBooking(flight.id), chosen("1A", "1B")),
      { outcome: "seats-unavailable", seats: ["1B"] },
    );
    assert.deepEqual(await statuses(subject, flight.id), [
      "1A:AVAILABLE", "1B:HELD", "1C:AVAILABLE", "1D:AVAILABLE", "1E:AVAILABLE", "1F:AVAILABLE",
    ]);
  });

  test(name("chosen seats that do not exist on the flight are unknown-seats, and nothing is held"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 6);

    assert.deepEqual(
      await book(subject, makeBooking(flight.id), chosen("1A", "40K", "2A")),
      { outcome: "unknown-seats", seats: ["40K", "2A"] },
    );
    assert.ok((await statuses(subject, flight.id)).every((seat) => seat.endsWith(":AVAILABLE")));
  });

  test(name("chosen seats on a flight not open for sale are sales-closed, even if they do not exist"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1, { status: "SCHEDULED" });

    assert.deepEqual(
      await book(subject, makeBooking(flight.id), chosen("1A", "40K")),
      { outcome: "sales-closed" },
    );
  });

  test(name("cancel releases every seat of a multi-seat booking"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 3);
    const booking = makeBooking(flight.id);
    await book(subject, booking, { kind: "auto", count: 3 });

    assert.deepEqual(await subject.repository.cancel(booking.id, ADMIN, CANCEL_AT), {
      outcome: "cancelled",
      flightId: flight.id,
    });
    assert.deepEqual(
      (await subject.seats(flight.id)).map((seat) => [seat.seat, seat.status, seat.bookingId]),
      [["1A", "AVAILABLE", null], ["1B", "AVAILABLE", null], ["1C", "AVAILABLE", null]],
    );
  });

  test(name("cancel releases the seat: a sold-out flight can allocate it again"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1);
    const first = makeBooking(flight.id);
    await book(subject, first);
    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "not-enough-seats" });

    await subject.repository.cancel(first.id, ADMIN, CANCEL_AT);

    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "held", seats: ["1A"] });
    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "not-enough-seats" });
  });

  test(name("a released seat in front is allocated before the free seats behind it"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 3);
    const inFront = makeBooking(flight.id);
    await book(subject, inFront); // 1A
    await book(subject, makeBooking(flight.id)); // 1B

    await subject.repository.cancel(inFront.id, ADMIN, CANCEL_AT);

    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "held", seats: ["1A"] });
    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "held", seats: ["1C"] });
  });

  test(name("an already-cancelled booking releases nothing a second time"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);
    const cancelledTwice = makeBooking(flight.id);
    await book(subject, cancelledTwice); // 1A
    await subject.repository.cancel(cancelledTwice.id, ADMIN, CANCEL_AT);
    await book(subject, makeBooking(flight.id)); // takes 1A again

    assert.deepEqual(await subject.repository.cancel(cancelledTwice.id, ADMIN, CANCEL_AT), {
      outcome: "already-cancelled",
    });
    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "held", seats: ["1B"] });
    assert.deepEqual(await book(subject, makeBooking(flight.id)), { outcome: "not-enough-seats" });
  });

  test(name("cancel on a HELD booking returns cancelled with its flightId"), async () => {
    const subject = await setup();
    const booking = await seedHeldBooking(subject);

    assert.deepEqual(await subject.repository.cancel(booking.id, ownerScope(ACCOUNT_A), CANCEL_AT), {
      outcome: "cancelled",
      flightId: booking.flightId,
    });
  });

  test(name("cancelling the same booking twice returns already-cancelled"), async () => {
    const subject = await setup();
    const booking = await seedHeldBooking(subject);
    await subject.repository.cancel(booking.id, ownerScope(ACCOUNT_A), CANCEL_AT);

    assert.deepEqual(await subject.repository.cancel(booking.id, ownerScope(ACCOUNT_A), CANCEL_AT), {
      outcome: "already-cancelled",
    });
  });

  test(name("a booking reads back as written: reference, passengers with their seat, HELD and its deadline"), async () => {
    const subject = await setup();
    const booking = await seedHeldBooking(subject);

    const stored = await subject.repository.findById(booking.id, ADMIN);

    assert.deepEqual(stored, booking);
    assert.deepEqual(stored?.passengers, [{ name: "Alice", seat: "1A" }]);
    assert.equal(stored?.holdExpiresAt, "2026-07-20T00:15:00.000Z");
  });

  test(name("a cancelled booking reads CANCELLED and keeps its passengers' seat copy (the seat itself is released)"), async () => {
    const subject = await setup();
    const booking = await seedHeldBooking(subject);

    await subject.repository.cancel(booking.id, ADMIN, CANCEL_AT);

    assert.deepEqual(await subject.repository.findById(booking.id, ADMIN), {
      ...booking,
      status: "CANCELLED",
    });
    assert.deepEqual(await book(subject, makeBooking(booking.flightId)), {
      outcome: "held",
      seats: ["1A"],
    });
  });

  // Day 48A (BR-BOOK-05): a taken reference is an outcome, and on Postgres it
  // must leave the transaction usable — the second create below runs in the
  // same transaction as the failed one.
  test(name("create with a taken reference is reference-taken, stores nothing, and the transaction goes on"), async () => {
    const subject = await setup();
    const first = await seedHeldBooking(subject);
    const flight = await seedFlight(subject, 1);
    const clash = makeBooking(flight.id);

    const results = await subject.transaction(async () => [
      await subject.repository.create({ ...clash, reference: first.reference }),
      await subject.repository.create(clash),
    ]);

    assert.deepEqual(results, [{ outcome: "reference-taken" }, { outcome: "created" }]);
    assert.deepEqual(await subject.repository.findById(clash.id, ADMIN), clash);
    assert.deepEqual(await subject.repository.findById(first.id, ADMIN), first);
  });

  test(name("findByReference finds the owner's booking; another account's reference is hidden; admin sees any"), async () => {
    const subject = await setup();
    const bookingOfA = await seedHeldBooking(subject, ACCOUNT_A);

    assert.deepEqual(
      await subject.repository.findByReference(bookingOfA.reference, ownerScope(ACCOUNT_A)),
      bookingOfA,
    );
    assert.equal(
      await subject.repository.findByReference(bookingOfA.reference, ownerScope(ACCOUNT_B)),
      undefined,
    );
    assert.deepEqual(
      await subject.repository.findByReference(bookingOfA.reference, ADMIN),
      bookingOfA,
    );
    assert.equal(await subject.repository.findByReference("ZZZZZZ", ADMIN), undefined);
  });

  test(name("cancel on an unknown booking returns not-found"), async () => {
    const subject = await setup();

    assert.deepEqual(await subject.repository.cancel(crypto.randomUUID(), ADMIN, CANCEL_AT), {
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
    const booking = await seedHeldBooking(subject, ACCOUNT_A);

    assert.deepEqual(await subject.repository.findById(booking.id, ownerScope(ACCOUNT_A)), booking);
  });

  test(name("findById hides another account's booking (BR-AUTH-02)"), async () => {
    const subject = await setup();
    const bookingOfB = await seedHeldBooking(subject, ACCOUNT_B);

    assert.equal(await subject.repository.findById(bookingOfB.id, ownerScope(ACCOUNT_A)), undefined);
  });

  test(name("findById with the admin scope sees any account's booking"), async () => {
    const subject = await setup();
    const bookingOfB = await seedHeldBooking(subject, ACCOUNT_B);

    assert.deepEqual(await subject.repository.findById(bookingOfB.id, ADMIN), bookingOfB);
  });

  test(name("cancel of another account's HELD booking is not-found and leaves it HELD"), async () => {
    const subject = await setup();
    const bookingOfB = await seedHeldBooking(subject, ACCOUNT_B);

    assert.deepEqual(await subject.repository.cancel(bookingOfB.id, ownerScope(ACCOUNT_A), CANCEL_AT), {
      outcome: "not-found",
    });
    assert.equal((await subject.repository.findById(bookingOfB.id, ADMIN))?.status, "HELD");
  });

  test(name("cancel of another account's already-cancelled booking is not-found, not already-cancelled"), async () => {
    const subject = await setup();
    const bookingOfB = await seedHeldBooking(subject, ACCOUNT_B);
    await subject.repository.cancel(bookingOfB.id, ownerScope(ACCOUNT_B), CANCEL_AT);

    assert.deepEqual(await subject.repository.cancel(bookingOfB.id, ownerScope(ACCOUNT_A), CANCEL_AT), {
      outcome: "not-found",
    });
  });

  test(name("findPage with an owner scope returns only that account's bookings, newest first"), async () => {
    const subject = await setup();
    const olderOfA = await seedHeldBooking(subject, ACCOUNT_A, "2026-07-20T00:00:00.000Z");
    await seedHeldBooking(subject, ACCOUNT_B, "2026-07-21T00:00:00.000Z");
    const newerOfA = await seedHeldBooking(subject, ACCOUNT_A, "2026-07-22T00:00:00.000Z");

    const page = await subject.repository.findPage(ownerScope(ACCOUNT_A), { limit: 10, offset: 0 });

    assert.deepEqual(page.items.map((b) => b.id), [newerOfA.id, olderOfA.id]);
    assert.equal(page.totalItems, 2);
  });

  test(name("findPage applies limit/offset after the scope; totalItems counts the whole scope"), async () => {
    const subject = await setup();
    await seedHeldBooking(subject, ACCOUNT_A, "2026-07-20T00:00:00.000Z");
    const middle = await seedHeldBooking(subject, ACCOUNT_A, "2026-07-21T00:00:00.000Z");
    await seedHeldBooking(subject, ACCOUNT_A, "2026-07-22T00:00:00.000Z");
    await seedHeldBooking(subject, ACCOUNT_B, "2026-07-23T00:00:00.000Z");

    const page = await subject.repository.findPage(ownerScope(ACCOUNT_A), { limit: 1, offset: 1 });

    assert.deepEqual(page.items.map((b) => b.id), [middle.id]);
    assert.equal(page.totalItems, 3);
  });

  // ---- Day 48B: hold expiry (Decision 12, BR-BOOK-10) ----

  const HOLD_MS = 15 * 60 * 1000;

  /** A HELD booking whose hold lapses at `holdExpiresAt`, holding `request`'s seats. */
  async function seedHold(
    subject: BookingRepositoryContractSubject,
    flight: Flight,
    holdExpiresAt: Date,
    request: SeatHoldRequest = { kind: "auto", count: 1 },
  ): Promise<Booking> {
    const booking = {
      ...makeBooking(flight.id),
      holdExpiresAt: holdExpiresAt.toISOString(),
    };
    const held = await book(subject, booking, request);
    assert.equal(held.outcome, "held");
    return booking;
  }

  test(name("expireDueHolds: a hold whose deadline is exactly now is expired, its seat released"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);
    const due = await seedHold(subject, flight, NOW);

    assert.deepEqual(await subject.repository.expireDueHolds(NOW, 50), [
      {
        bookingId: due.id,
        reference: due.reference,
        flightId: flight.id,
        ownerAccountId: ACCOUNT_A,
        holdExpiresAt: NOW.toISOString(),
        seats: ["1A"],
      },
    ]);
    assert.equal((await subject.repository.findById(due.id, ADMIN))?.status, "EXPIRED");
    assert.deepEqual(await statuses(subject, flight.id), ["1A:AVAILABLE", "1B:AVAILABLE"]);
  });

  test(name("expireDueHolds: a hold lapsing 1 ms after now is untouched"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 1);
    const valid = await seedHold(subject, flight, new Date(NOW.getTime() + 1));

    assert.deepEqual(await subject.repository.expireDueHolds(NOW, 50), []);
    assert.equal((await subject.repository.findById(valid.id, ADMIN))?.status, "HELD");
    assert.deepEqual(await statuses(subject, flight.id), ["1A:HELD"]);
  });

  test(name("expireDueHolds touches only HELD: CONFIRMED, CANCELLED and EXPIRED with past deadlines stay as they are"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 3);
    const past = new Date(NOW.getTime() - HOLD_MS);
    const cancelled = await seedHold(subject, flight, past);
    await subject.repository.cancel(cancelled.id, ADMIN, CANCEL_AT);
    const expired = await seedHold(subject, flight, past);
    assert.equal((await subject.repository.expireDueHolds(NOW, 50)).length, 1);
    // CONFIRMED keeps its old deadline as history. Stored directly: no port
    // method confirms a booking before payment (step 6).
    const confirmed: Booking = {
      ...makeBooking(flight.id),
      status: "CONFIRMED",
      holdExpiresAt: past.toISOString(),
    };
    assert.deepEqual(await subject.repository.create(confirmed), { outcome: "created" });
    const before = await statuses(subject, flight.id);

    assert.deepEqual(await subject.repository.expireDueHolds(NOW, 50), []);
    assert.equal((await subject.repository.findById(cancelled.id, ADMIN))?.status, "CANCELLED");
    assert.equal((await subject.repository.findById(expired.id, ADMIN))?.status, "EXPIRED");
    assert.equal((await subject.repository.findById(confirmed.id, ADMIN))?.status, "CONFIRMED");
    assert.deepEqual(await statuses(subject, flight.id), before);
  });

  test(name("expireDueHolds takes at most `limit`, oldest deadline first then id, and the next call takes the rest"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 6);
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
    // Seeded out of order; two share a deadline, so id decides between them.
    const newest = await seedHold(subject, flight, at(1));
    const tieOne = await seedHold(subject, flight, at(5));
    const oldest = await seedHold(subject, flight, at(9));
    const tieTwo = await seedHold(subject, flight, at(5));
    const [tieFirst, tieSecond] = [tieOne.id, tieTwo.id].sort();

    const first = await subject.repository.expireDueHolds(NOW, 2);
    const second = await subject.repository.expireDueHolds(NOW, 2);
    const third = await subject.repository.expireDueHolds(NOW, 2);

    assert.deepEqual(first.map((hold) => hold.bookingId), [oldest.id, tieFirst]);
    assert.deepEqual(second.map((hold) => hold.bookingId), [tieSecond, newest.id]);
    assert.deepEqual(third, []);
  });

  test(name("expireDueHolds releases every seat of a multi-seat hold, in (row, letter) order, and they can be held again"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 12);
    const due = await seedHold(subject, flight, NOW, chosen("2B", "1C", "2A"));

    const [expired] = await subject.repository.expireDueHolds(NOW, 50);

    assert.deepEqual(expired?.seats, ["1C", "2A", "2B"]);
    assert.ok(
      (await subject.seats(flight.id)).every(
        (seat) => seat.status === "AVAILABLE" && seat.bookingId === null,
      ),
    );
    // The booking keeps its passengers' seat copy, like a cancelled one.
    assert.deepEqual(await subject.repository.findById(due.id, ADMIN), {
      ...withSeats(due, ["2B", "1C", "2A"]),
      status: "EXPIRED",
    });
    assert.deepEqual(
      await book(subject, makeBooking(flight.id), chosen("2A", "1C", "2B")),
      { outcome: "held", seats: ["2A", "1C", "2B"] },
    );
  });

  test(name("cancel at the exact deadline is expired and writes nothing — and the sweep at that same instant expires it"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);
    const due = await seedHold(subject, flight, NOW);

    assert.deepEqual(await subject.repository.cancel(due.id, ADMIN, NOW), { outcome: "expired" });
    assert.equal((await subject.repository.findById(due.id, ADMIN))?.status, "HELD");
    assert.deepEqual(await statuses(subject, flight.id), ["1A:HELD", "1B:AVAILABLE"]);

    // Complementary sides of BR-BOOK-10: the instant cancel refuses is one
    // the sweep takes — no deadline falls between the two.
    assert.deepEqual(
      (await subject.repository.expireDueHolds(NOW, 50)).map((hold) => hold.bookingId),
      [due.id],
    );
  });

  test(name("cancel 1 ms before the deadline cancels and releases the seats"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);
    const valid = await seedHold(subject, flight, NOW, { kind: "auto", count: 2 });

    assert.deepEqual(
      await subject.repository.cancel(valid.id, ownerScope(ACCOUNT_A), new Date(NOW.getTime() - 1)),
      { outcome: "cancelled", flightId: flight.id },
    );
    assert.deepEqual(await statuses(subject, flight.id), ["1A:AVAILABLE", "1B:AVAILABLE"]);
    assert.deepEqual(await subject.repository.expireDueHolds(NOW, 50), []);
  });

  test(name("cancel of a swept EXPIRED booking is expired; of another account's lapsed hold, not-found"), async () => {
    const subject = await setup();
    const flight = await seedFlight(subject, 2);
    const swept = await seedHold(subject, flight, NOW);
    await subject.repository.expireDueHolds(NOW, 50);
    const lapsedOfA = await seedHold(subject, flight, NOW);
    const later = new Date(NOW.getTime() + HOLD_MS);

    assert.deepEqual(await subject.repository.cancel(swept.id, ADMIN, later), { outcome: "expired" });
    // Out of scope is not-found whatever the state (BR-AUTH-02).
    assert.deepEqual(
      await subject.repository.cancel(lapsedOfA.id, ownerScope(ACCOUNT_B), later),
      { outcome: "not-found" },
    );
    assert.equal((await subject.repository.findById(swept.id, ADMIN))?.status, "EXPIRED");
  });

  test(name("findPage with the admin scope returns every account's bookings"), async () => {
    const subject = await setup();
    await seedHeldBooking(subject, ACCOUNT_A, "2026-07-20T00:00:00.000Z");
    await seedHeldBooking(subject, ACCOUNT_B, "2026-07-21T00:00:00.000Z");

    const page = await subject.repository.findPage(ADMIN, { limit: 10, offset: 0 });

    assert.equal(page.totalItems, 2);
  });
}
