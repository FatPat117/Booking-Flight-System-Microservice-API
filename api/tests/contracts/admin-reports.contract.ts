import assert from "node:assert/strict";
import test from "node:test";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import type { AuditRecordInput } from "../../src/audit/audit-recorder.js";
import type { BookingRepository } from "../../src/bookings/booking-repository.js";
import type { FlightRepository } from "../../src/flights/flight-repository.js";
import type { AdminReports, LoadFactorQuery } from "../../src/reports/admin-reports.js";
import type { Flight } from "../../src/types.js";
import { makeBooking, passengersFor } from "../fixtures/bookings.js";
import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_LONDON,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight,
} from "../fixtures/flights.js";

/**
 * What every AdminReports promises (Day 53, Decision 19), run against the
 * in-memory fake (unit tier) and Postgres (integration tier). The fake walks
 * seats and asks Intl for local dates; Postgres counts in SQL and widens a
 * UTC window — the cases below keep them together.
 *
 * The two-class fixture aircraft has 12 BUSINESS seats (1A–2F) and 18
 * ECONOMY seats (3A–5F). ZZA is Asia/Ho_Chi_Minh (UTC+7), ZZL Europe/London.
 */
export type AdminReportsContractSubject = Readonly<{
  reports: AdminReports;
  flights: FlightRepository;
  bookings: BookingRepository;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /** Stores an audit entry as AuditRecorder does (in a transaction on Postgres). */
  record(entry: AuditRecordInput): Promise<void>;
}>;

const NOW = new Date("2026-10-10T00:00:00.000Z");
const VALID = new Date(NOW.getTime() + 15 * 60_000).toISOString();
const LAPSED = new Date(NOW.getTime() - 60_000).toISOString();
const ADMIN = { kind: "admin" } as const;
const HOUR_MS = 60 * 60 * 1000;

function flightAt(departureAt: string, overrides: Partial<Flight> = {}): Flight {
  const departure = Date.parse(departureAt);
  return makeFlight({
    aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID,
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + 2 * HOUR_MS).toISOString(),
    ...overrides,
  });
}

export function runAdminReportsContract(
  implementation: string,
  setup: () => Promise<AdminReportsContractSubject>,
): void {
  const name = (behavior: string) => `AdminReports contract (${implementation}): ${behavior}`;

  async function addFlight(subject: AdminReportsContractSubject, flight: Flight): Promise<Flight> {
    assert.deepEqual(await subject.flights.create(flight), { outcome: "created" });
    return flight;
  }

  /** Holds the named seats for one booking whose hold ends at `holdExpiresAt`. */
  async function hold(
    subject: AdminReportsContractSubject,
    flightId: string,
    seats: string[],
    holdExpiresAt: string,
    names?: string[],
  ) {
    const booking = makeBooking({ flightId, holdExpiresAt });
    return subject.transaction(async () => {
      const held = await subject.bookings.holdSeats(
        flightId,
        booking.id,
        {
          kind: "chosen",
          seats: seats.map((code) => {
            const position = parseSeatPosition(code);
            assert.ok(position, code);
            return position;
          }),
        },
        NOW,
      );
      assert.equal(held.outcome, "held");
      if (held.outcome !== "held") throw new Error("not held");
      const passengers = passengersFor(held.seats, names);
      assert.deepEqual(await subject.bookings.create({ ...booking, passengers }), { outcome: "created" });
      return booking;
    });
  }

  async function confirmed(subject: AdminReportsContractSubject, flightId: string, seats: string[], names?: string[]) {
    const booking = await hold(subject, flightId, seats, VALID, names);
    assert.equal((await subject.bookings.confirmHold(booking.id, ADMIN, NOW)).outcome, "confirmed");
    return booking;
  }

  test(name("the manifest counts each class's seats and lists only CONFIRMED passengers, in seat order, with four fields"), async () => {
    const subject = await setup();
    const flight = await addFlight(subject, flightAt("2027-02-01T01:00:00.000Z"));
    const pair = await confirmed(subject, flight.id, ["1C", "1A"], ["Lan Tran", "Minh Le"]);
    const single = await confirmed(subject, flight.id, ["3B"], ["An Pham"]);
    await hold(subject, flight.id, ["3C"], VALID, ["Held Valid"]);
    await hold(subject, flight.id, ["3D"], LAPSED, ["Held Lapsed"]);
    const gone = await confirmed(subject, flight.id, ["4A"], ["Cancelled Person"]);
    assert.equal((await subject.bookings.cancel(gone.id, ADMIN, NOW, "CUSTOMER")).outcome, "cancelled");

    const manifest = await subject.reports.findManifest(flight.id, NOW);
    assert.ok(manifest);

    assert.deepEqual(manifest.flight, {
      id: flight.id,
      flightNumber: flight.flightNumber,
      origin: FIXTURE_ORIGIN.code,
      originTimeZone: "Asia/Ho_Chi_Minh",
      destination: flight.destination,
      departureAt: flight.departureAt,
      status: "OPEN",
    });
    assert.deepEqual(manifest.classes, [
      { fareClass: "BUSINESS", total: 12, booked: 2, held: 0, available: 10 },
      // 3D's hold has lapsed and the job has not swept it: available in effect.
      { fareClass: "ECONOMY", total: 18, booked: 1, held: 1, available: 16 },
    ]);
    assert.equal(manifest.heldBookings, 1);
    assert.deepEqual(manifest.passengers, [
      { reference: pair.reference, name: "Minh Le", seat: "1A", fareClass: "BUSINESS" },
      { reference: pair.reference, name: "Lan Tran", seat: "1C", fareClass: "BUSINESS" },
      { reference: single.reference, name: "An Pham", seat: "3B", fareClass: "ECONOMY" },
    ]);
    for (const passenger of manifest.passengers) {
      assert.deepEqual(Object.keys(passenger).sort(), ["fareClass", "name", "reference", "seat"]);
    }
  });

  test(name("the manifest of an empty flight lists no one and every seat available; an unknown flight is undefined"), async () => {
    const subject = await setup();
    const flight = await addFlight(subject, flightAt("2027-02-02T01:00:00.000Z"));

    const manifest = await subject.reports.findManifest(flight.id, NOW);
    assert.deepEqual(manifest?.classes, [
      { fareClass: "BUSINESS", total: 12, booked: 0, held: 0, available: 12 },
      { fareClass: "ECONOMY", total: 18, booked: 0, held: 0, available: 18 },
    ]);
    assert.deepEqual(manifest?.passengers, []);
    assert.equal(manifest?.heldBookings, 0);
    assert.equal(await subject.reports.findManifest(crypto.randomUUID(), NOW), undefined);
  });

  /**
   * f1 23:59 local on 10 March (ZZA, +7); f2 00:00 local on 11 March (ZZA);
   * f3 23:30 local on 11 March in London (already the 12th at +7);
   * f4 10:00 local on 12 March (ZZA), cancelled (the same aircraft as f3, after its turnaround).
   */
  async function marchFlights(subject: AdminReportsContractSubject) {
    const f1 = await addFlight(subject, flightAt("2027-03-10T16:59:00.000Z", { aircraftId: FIXTURE_AIRCRAFT_ID }));
    const f2 = await addFlight(subject, flightAt("2027-03-10T17:00:00.000Z", { aircraftId: FIXTURE_OTHER_AIRCRAFT_ID }));
    const f3 = await addFlight(
      subject,
      flightAt("2027-03-11T23:30:00.000Z", { originAirportId: FIXTURE_LONDON.id, origin: FIXTURE_LONDON.code }),
    );
    const f4 = await addFlight(subject, flightAt("2027-03-12T03:00:00.000Z"));
    assert.deepEqual(await subject.flights.changeStatus(f4.id, "OPEN", "CANCELLED"), { outcome: "changed" });
    return { f1, f2, f3, f4 };
  }

  const ids = (page: { items: ReadonlyArray<{ id: string }> }) => page.items.map((item) => item.id);
  const range = (dateFrom: string, dateTo: string, extra: Partial<LoadFactorQuery> = {}): LoadFactorQuery => ({
    dateFrom,
    dateTo,
    limit: 50,
    ...extra,
  });

  test(name("load factor reads each flight's date in its own origin's zone, at both ends of the day"), async () => {
    const subject = await setup();
    const { f1, f2, f3, f4 } = await marchFlights(subject);

    assert.deepEqual(ids(await subject.reports.loadFactor(range("2027-03-10", "2027-03-10"), NOW)), [f1.id]);
    assert.deepEqual(ids(await subject.reports.loadFactor(range("2027-03-11", "2027-03-11"), NOW)), [f2.id, f3.id]);
    assert.deepEqual(ids(await subject.reports.loadFactor(range("2027-03-10", "2027-03-12"), NOW)), [
      f1.id,
      f2.id,
      f3.id,
      f4.id,
    ]);
    assert.deepEqual(
      ids(await subject.reports.loadFactor(range("2027-03-10", "2027-03-12", { origin: FIXTURE_LONDON.code }), NOW)),
      [f3.id],
    );
  });

  test(name("load factor lists a cancelled flight with its status and counts every class: available + held + booked = total"), async () => {
    const subject = await setup();
    const { f2, f4 } = await marchFlights(subject);
    await confirmed(subject, f2.id, ["1A"]);
    await hold(subject, f2.id, ["1B"], VALID);
    await hold(subject, f2.id, ["1C"], LAPSED);

    const page = await subject.reports.loadFactor(range("2027-03-11", "2027-03-12"), NOW);
    const second = page.items.find((item) => item.id === f2.id);
    assert.deepEqual(second?.classes, [{ fareClass: "ECONOMY", total: 5, booked: 1, held: 1, available: 3 }]);
    assert.equal(page.items.find((item) => item.id === f4.id)?.status, "CANCELLED");
    for (const item of page.items) {
      for (const seats of item.classes) {
        assert.equal(seats.available + seats.held + seats.booked, seats.total, `${item.flightNumber} ${seats.fareClass}`);
      }
    }
  });

  test(name("load factor pages by (departureAt, id): limit, hasNextPage, then the rest after the last key"), async () => {
    const subject = await setup();
    const { f1, f2, f3, f4 } = await marchFlights(subject);

    const first = await subject.reports.loadFactor(range("2027-03-10", "2027-03-12", { limit: 2 }), NOW);
    assert.deepEqual(ids(first), [f1.id, f2.id]);
    assert.equal(first.hasNextPage, true);
    const last = first.items.at(-1);
    assert.ok(last);
    const second = await subject.reports.loadFactor(
      range("2027-03-10", "2027-03-12", { limit: 2, after: { at: last.departureAt, id: last.id } }),
      NOW,
    );
    assert.deepEqual(ids(second), [f3.id, f4.id]);
    assert.equal(second.hasNextPage, false);
  });

  /** Five entries: two targets, two actors, two actions, one tie on occurredAt. */
  async function auditEntries(subject: AdminReportsContractSubject) {
    const booking = crypto.randomUUID();
    const flight = crypto.randomUUID();
    const entry = (
      id: string,
      action: AuditRecordInput["action"],
      target: AuditRecordInput["target"],
      actor: AuditRecordInput["actor"],
      occurredAt: string,
    ): AuditRecordInput => ({ id, action, target, actor, occurredAt, metadata: { n: 1 } });
    const alice = { type: "account", id: "11111111-1111-4111-8111-111111111111" } as const;
    const job = { type: "system", id: "booking-expiry" } as const;
    const entries = [
      entry("00000000-0000-4000-8000-000000000001", "BOOKING_CREATED", { type: "booking", id: booking }, alice, "2026-09-01T10:00:00.000Z"),
      entry("00000000-0000-4000-8000-000000000002", "BOOKING_CONFIRMED", { type: "booking", id: booking }, alice, "2026-09-01T10:05:00.000Z"),
      entry("00000000-0000-4000-8000-000000000003", "FLIGHT_OPENED", { type: "flight", id: flight }, alice, "2026-09-01T10:05:00.000Z"),
      entry("00000000-0000-4000-8000-000000000004", "BOOKING_EXPIRED", { type: "booking", id: booking }, job, "2026-09-02T00:00:00.000Z"),
      entry("00000000-0000-4000-8000-000000000005", "FLIGHT_OPENED", { type: "flight", id: flight }, alice, "2026-09-03T00:00:00.000Z"),
    ];
    for (const one of entries) await subject.record(one);
    return { booking, flight, entries };
  }

  const last4 = (page: { items: ReadonlyArray<{ id: string }> }) => page.items.map((item) => item.id.slice(-1));

  test(name("the audit log filters by target, time range [from, to), actor and action, alone or together, newest first"), async () => {
    const subject = await setup();
    const { booking, flight } = await auditEntries(subject);

    assert.deepEqual(last4(await subject.reports.auditLog({ target: { type: "booking", id: booking }, limit: 50 })), ["4", "2", "1"]);
    // The tie at 10:05 is broken by id, descending.
    assert.deepEqual(
      last4(await subject.reports.auditLog({ range: { from: "2026-09-01T10:05:00.000Z", to: "2026-09-02T00:00:00.000Z" }, limit: 50 })),
      ["3", "2"],
    );
    assert.deepEqual(
      last4(await subject.reports.auditLog({ range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" }, actorType: "system", limit: 50 })),
      ["4"],
    );
    assert.deepEqual(
      last4(await subject.reports.auditLog({ target: { type: "flight", id: flight }, action: "FLIGHT_OPENED", actorId: "11111111-1111-4111-8111-111111111111", limit: 50 })),
      ["5", "3"],
    );
    assert.deepEqual(
      (await subject.reports.auditLog({ target: { type: "booking", id: crypto.randomUUID() }, limit: 50 })).items,
      [],
    );
  });

  test(name("an audit entry reads back whole, and pages continue strictly older than the last key, through a tie"), async () => {
    const subject = await setup();
    const { entries } = await auditEntries(subject);
    const window = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" };

    const first = await subject.reports.auditLog({ range: window, limit: 2 });
    assert.deepEqual(last4(first), ["5", "4"]);
    assert.equal(first.hasNextPage, true);
    assert.deepEqual(first.items[1], {
      id: entries[3]?.id,
      action: "BOOKING_EXPIRED",
      actor: { type: "system", id: "booking-expiry" },
      target: entries[3]?.target,
      requestId: null,
      occurredAt: "2026-09-02T00:00:00.000Z",
      metadata: { n: 1 },
    });

    const seen = [...last4(first)];
    let after = { at: first.items[1]!.occurredAt, id: first.items[1]!.id };
    for (;;) {
      const page = await subject.reports.auditLog({ range: window, limit: 2, after });
      seen.push(...last4(page));
      const tail = page.items.at(-1);
      if (!page.hasNextPage || tail === undefined) break;
      after = { at: tail.occurredAt, id: tail.id };
    }
    assert.deepEqual(seen, ["5", "4", "3", "2", "1"]);
  });
}
