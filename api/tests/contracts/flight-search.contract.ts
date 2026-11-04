import assert from "node:assert/strict";
import test from "node:test";

import type { FlightSearch, FlightSearchQuery } from "../../src/flights/flight-search.js";
import { vnd } from "../../src/money/money.js";
import type { Flight } from "../../src/types.js";
import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_LONDON,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight,
} from "../fixtures/flights.js";

/**
 * What every FlightSearch promises (Day 51, Decision 17, BR-FLT-10), run
 * against the in-memory fake (unit tier) and Postgres (integration tier).
 * The fake finds each flight's local date with Intl; Postgres turns the
 * dates into a UTC interval — the named boundary cases keep them together.
 *
 * Airports: ZZA and ZZB are Asia/Ho_Chi_Minh (UTC+7, no DST), ZZL is
 * Europe/London. The two-class aircraft has 12 BUSINESS seats (1A–2F) and
 * 18 ECONOMY seats (3A–5F); fares 1 500 000 and 4 200 000 VND.
 */
export type FlightSearchSubject = Readonly<{
  search: FlightSearch;
  addFlight(flight: Flight): Promise<void>;
  /** Sells these seats of the flight (BOOKED, owned by one booking). */
  occupy(flightId: string, seats: readonly string[]): Promise<void>;
}>;

const NOW = new Date("2027-01-01T00:00:00.000Z");
const ECONOMY = vnd(1_500_000);
const BUSINESS = vnd(4_200_000);
const ALL_BUSINESS = ["1A", "1B", "1C", "1D", "1E", "1F", "2A", "2B", "2C", "2D", "2E", "2F"];
const ECONOMY_SEATS = ["3A", "3B", "3C", "3D", "3E", "3F", "4A", "4B", "4C", "4D", "4E", "4F", "5A", "5B", "5C", "5D", "5E", "5F"];

type Place = Readonly<{ id: string; code: string }>;

/** A two-hour flight on the two-class aircraft unless told otherwise. */
function flightAt(
  departureAt: string,
  options: { from?: Place; to?: Place; aircraftId?: string; status?: Flight["status"] } = {},
): Flight {
  const from = options.from ?? FIXTURE_ORIGIN;
  const to = options.to ?? FIXTURE_DESTINATION;
  const departure = new Date(departureAt).getTime();
  return makeFlight({
    aircraftId: options.aircraftId ?? FIXTURE_TWO_CLASS_AIRCRAFT_ID,
    originAirportId: from.id,
    origin: from.code,
    destinationAirportId: to.id,
    destination: to.code,
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + 2 * 60 * 60 * 1000).toISOString(),
    status: options.status ?? "OPEN",
  });
}

function query(overrides: Partial<FlightSearchQuery> = {}): FlightSearchQuery {
  return {
    origin: FIXTURE_ORIGIN.code,
    destination: FIXTURE_DESTINATION.code,
    departureDateFrom: "2027-03-11",
    departureDateTo: "2027-03-11",
    passengers: 1,
    sort: "departure",
    limit: 20,
    ...overrides,
  };
}

export function runFlightSearchContract(
  implementation: string,
  setup: () => Promise<FlightSearchSubject>,
): void {
  const name = (behavior: string) => `FlightSearch contract (${implementation}): ${behavior}`;

  async function ids(subject: FlightSearchSubject, q: FlightSearchQuery, now = NOW) {
    return (await subject.search.search(q, now)).items.map((item) => item.id);
  }

  test(name("local midnight and 23:59 at the origin are on that local date, not on the dates beside it (UTC+7)"), async () => {
    const subject = await setup();
    const midnight = flightAt("2027-03-10T17:00:00.000Z"); // 2027-03-11 00:00 local
    const lastMinute = flightAt("2027-03-11T16:59:00.000Z"); // 2027-03-11 23:59 local
    const nextDay = flightAt("2027-03-11T17:00:00.000Z", { aircraftId: FIXTURE_AIRCRAFT_ID }); // 03-12 00:00
    for (const flight of [midnight, lastMinute, nextDay]) await subject.addFlight(flight);

    assert.deepEqual(await ids(subject, query()), [midnight.id, lastMinute.id]);
    assert.deepEqual(await ids(subject, query({ departureDateFrom: "2027-03-10", departureDateTo: "2027-03-10" })), []);
    assert.deepEqual(await ids(subject, query({ departureDateFrom: "2027-03-12", departureDateTo: "2027-03-12" })), [nextDay.id]);
  });

  test(name("06:00 local on 20 November is found on the 20th although it is 23:00 UTC on the 19th"), async () => {
    const subject = await setup();
    const early = flightAt("2027-11-19T23:00:00.000Z");
    await subject.addFlight(early);

    assert.deepEqual(await ids(subject, query({ departureDateFrom: "2027-11-20", departureDateTo: "2027-11-20" })), [early.id]);
    assert.deepEqual(await ids(subject, query({ departureDateFrom: "2027-11-19", departureDateTo: "2027-11-19" })), []);
  });

  test(name("23:30 local on 20 November is on the 20th, not on the 21st"), async () => {
    const subject = await setup();
    const late = flightAt("2027-11-20T16:30:00.000Z");
    await subject.addFlight(late);

    assert.deepEqual(await ids(subject, query({ departureDateFrom: "2027-11-21", departureDateTo: "2027-11-21" })), []);
    assert.deepEqual(await ids(subject, query({ departureDateFrom: "2027-11-20", departureDateTo: "2027-11-20" })), [late.id]);
  });

  test(name("a date range is inclusive at both ends"), async () => {
    const subject = await setup();
    const first = flightAt("2027-03-10T17:30:00.000Z"); // 03-11 local
    const last = flightAt("2027-03-13T16:30:00.000Z"); // 03-13 local
    const after = flightAt("2027-03-13T17:30:00.000Z", { aircraftId: FIXTURE_AIRCRAFT_ID }); // 03-14 local
    for (const flight of [first, last, after]) await subject.addFlight(flight);

    assert.deepEqual(await ids(subject, query({ departureDateTo: "2027-03-13" })), [first.id, last.id]);
  });

  test(name("London's spring-forward day is 23 hours long: 23:30 BST is on the 28th, 00:30 BST is on the 29th"), async () => {
    const subject = await setup();
    const london = { from: FIXTURE_LONDON, to: FIXTURE_ORIGIN };
    const lateOn28 = flightAt("2027-03-28T22:30:00.000Z", london); // 23:30 BST, 28 March
    const earlyOn29 = flightAt("2027-03-28T23:30:00.000Z", { ...london, aircraftId: FIXTURE_AIRCRAFT_ID }); // 00:30 BST, 29 March
    for (const flight of [lateOn28, earlyOn29]) await subject.addFlight(flight);
    const fromLondon = { origin: FIXTURE_LONDON.code, destination: FIXTURE_ORIGIN.code };

    assert.deepEqual(await ids(subject, query({ ...fromLondon, departureDateFrom: "2027-03-28", departureDateTo: "2027-03-28" })), [lateOn28.id]);
    assert.deepEqual(await ids(subject, query({ ...fromLondon, departureDateFrom: "2027-03-29", departureDateTo: "2027-03-29" })), [earlyOn29.id]);
  });

  test(name("London's fall-back day is 25 hours long: 00:30 BST on the 31st (23:30 UTC on the 30th) is on the 31st"), async () => {
    const subject = await setup();
    const london = { from: FIXTURE_LONDON, to: FIXTURE_ORIGIN };
    const earlyOn31 = flightAt("2027-10-30T23:30:00.000Z", london); // 00:30 BST, 31 October
    const lateOn31 = flightAt("2027-10-31T23:30:00.000Z", { ...london, aircraftId: FIXTURE_AIRCRAFT_ID }); // 23:30 GMT, 31 October
    for (const flight of [earlyOn31, lateOn31]) await subject.addFlight(flight);
    const fromLondon = { origin: FIXTURE_LONDON.code, destination: FIXTURE_ORIGIN.code };

    assert.deepEqual(
      await ids(subject, query({ ...fromLondon, departureDateFrom: "2027-10-31", departureDateTo: "2027-10-31" })),
      [earlyOn31.id, lateOn31.id],
    );
    assert.deepEqual(await ids(subject, query({ ...fromLondon, departureDateFrom: "2027-10-30", departureDateTo: "2027-10-30" })), []);
  });

  test(name("sales close exactly 1 hour before departure, as for the hold: at that instant the flight is gone, 1 ms earlier it is found"), async () => {
    const subject = await setup();
    const flight = flightAt("2027-03-11T03:00:00.000Z");
    await subject.addFlight(flight);
    const close = new Date("2027-03-11T02:00:00.000Z");

    assert.deepEqual(await ids(subject, query(), new Date(close.getTime() - 1)), [flight.id]);
    assert.deepEqual(await ids(subject, query(), close), []);
  });

  test(name("only OPEN flights before sales close are found: SCHEDULED, CANCELLED and departed ones are not"), async () => {
    const subject = await setup();
    const open = flightAt("2027-03-11T01:00:00.000Z");
    const scheduled = flightAt("2027-03-11T01:00:00.000Z", { aircraftId: FIXTURE_AIRCRAFT_ID, status: "SCHEDULED" });
    const cancelled = flightAt("2027-03-11T01:00:00.000Z", { aircraftId: FIXTURE_OTHER_AIRCRAFT_ID, status: "CANCELLED" });
    for (const flight of [open, scheduled, cancelled]) await subject.addFlight(flight);

    assert.deepEqual(await ids(subject, query()), [open.id]);
    assert.deepEqual(await ids(subject, query(), new Date("2027-03-11T01:00:00.000Z")), []);
  });

  test(name("room for N passengers means N free seats in one class: exactly N is enough, N − 1 is not"), async () => {
    const subject = await setup();
    const flight = flightAt("2027-03-11T01:00:00.000Z");
    await subject.addFlight(flight);
    await subject.occupy(flight.id, [...ALL_BUSINESS, ...ECONOMY_SEATS.slice(2)]); // 2 economy left

    const page = await subject.search.search(query({ passengers: 2 }), NOW);
    assert.deepEqual(page.items.map((item) => item.id), [flight.id]);
    assert.deepEqual(page.items[0]?.lowestFare, ECONOMY);
    assert.deepEqual(await ids(subject, query({ passengers: 3 })), []);
  });

  test(name("seats spread over two classes do not add up: 1 economy + 1 business is no room for 2"), async () => {
    const subject = await setup();
    const flight = flightAt("2027-03-11T01:00:00.000Z");
    await subject.addFlight(flight);
    await subject.occupy(flight.id, [...ALL_BUSINESS.slice(1), ...ECONOMY_SEATS.slice(1)]);

    assert.deepEqual(await ids(subject, query({ passengers: 2 })), []);
    assert.deepEqual(await ids(subject, query({ passengers: 1 })), [flight.id]);
  });

  test(name("lowestFare is the cheapest class with room for everyone; availability lists every class, cheapest first, sold-out ones with 0"), async () => {
    const subject = await setup();
    const flight = flightAt("2027-03-11T01:00:00.000Z");
    await subject.addFlight(flight);
    await subject.occupy(flight.id, ECONOMY_SEATS.slice(1)); // 1 economy left

    const [single] = (await subject.search.search(query({ passengers: 1 }), NOW)).items;
    assert.deepEqual(single?.lowestFare, ECONOMY);
    const [pair] = (await subject.search.search(query({ passengers: 2 }), NOW)).items;
    assert.deepEqual(pair, {
      id: flight.id,
      flightNumber: flight.flightNumber,
      origin: { code: FIXTURE_ORIGIN.code, timeZone: "Asia/Ho_Chi_Minh" },
      destination: { code: FIXTURE_DESTINATION.code, timeZone: "Asia/Ho_Chi_Minh" },
      departureAt: flight.departureAt,
      arrivalAt: flight.arrivalAt,
      lowestFare: BUSINESS,
      availability: [
        { fareClass: "ECONOMY", availableSeats: 1, fare: ECONOMY },
        { fareClass: "BUSINESS", availableSeats: 12, fare: BUSINESS },
      ],
    });

    await subject.occupy(flight.id, ECONOMY_SEATS.slice(0, 1));
    const [soldOut] = (await subject.search.search(query({ passengers: 1 }), NOW)).items;
    assert.deepEqual(soldOut?.availability[0], { fareClass: "ECONOMY", availableSeats: 0, fare: ECONOMY });
  });

  test(name("the route is directional, and an unknown airport code finds nothing"), async () => {
    const subject = await setup();
    await subject.addFlight(flightAt("2027-03-11T01:00:00.000Z"));

    assert.deepEqual(await ids(subject, query({ origin: FIXTURE_DESTINATION.code, destination: FIXTURE_ORIGIN.code })), []);
    assert.deepEqual(await ids(subject, query({ origin: "QQQ" })), []);
  });

  test(name("by departure, ties broken by id; by price, the lowest fare first, then departure, then id"), async () => {
    const subject = await setup();
    const cheapLate = flightAt("2027-03-11T05:00:00.000Z", { aircraftId: FIXTURE_AIRCRAFT_ID }); // economy only, 1 500 000
    const sameMinuteA = flightAt("2027-03-11T01:00:00.000Z");
    const sameMinuteB = flightAt("2027-03-11T01:00:00.000Z", { aircraftId: FIXTURE_OTHER_AIRCRAFT_ID });
    for (const flight of [cheapLate, sameMinuteA, sameMinuteB]) await subject.addFlight(flight);
    await subject.occupy(sameMinuteA.id, ECONOMY_SEATS); // only business left: 4 200 000

    const [first, second] = [sameMinuteA.id, sameMinuteB.id].sort();
    assert.deepEqual(await ids(subject, query()), [first, second, cheapLate.id]);
    // B: economy-only aircraft, 1 500 000 at 01:00; cheapLate: 1 500 000 at 05:00; A: only business left.
    assert.deepEqual(await ids(subject, query({ sort: "price" })), [sameMinuteB.id, cheapLate.id, sameMinuteA.id]);
  });

  test(name("a page of `limit` says whether more follow, and `after` continues past the given key"), async () => {
    const subject = await setup();
    const one = flightAt("2027-03-11T01:00:00.000Z");
    const two = flightAt("2027-03-11T05:00:00.000Z");
    for (const flight of [one, two]) await subject.addFlight(flight);

    const first = await subject.search.search(query({ limit: 1 }), NOW);
    assert.deepEqual([first.items.map((item) => item.id), first.hasNextPage], [[one.id], true]);
    const next = await subject.search.search(
      query({ limit: 1, after: { departureAt: one.departureAt, id: one.id, lowestFare: ECONOMY.amount } }),
      NOW,
    );
    assert.deepEqual([next.items.map((item) => item.id), next.hasNextPage], [[two.id], false]);
  });

  // ---- US-FLT-05: one flight's details ----

  test(name("details count each class's free seats with its fare, cheapest first, and carry both airports' zones"), async () => {
    const subject = await setup();
    const flight = flightAt("2027-03-11T01:00:00.000Z", { to: FIXTURE_LONDON });
    await subject.addFlight(flight);
    await subject.occupy(flight.id, [...ALL_BUSINESS.slice(0, 5), ...ECONOMY_SEATS.slice(0, 3)]);

    const details = await subject.search.findDetails(flight.id);
    assert.deepEqual(details, {
      ...flight,
      availableSeats: 22,
      originTimeZone: "Asia/Ho_Chi_Minh",
      destinationTimeZone: "Europe/London",
      availability: [
        { fareClass: "ECONOMY", availableSeats: 15, fare: ECONOMY },
        { fareClass: "BUSINESS", availableSeats: 7, fare: BUSINESS },
      ],
    });
  });

  test(name("details of an unknown flight are undefined; a sold-out class still appears with 0"), async () => {
    const subject = await setup();
    const flight = flightAt("2027-03-11T01:00:00.000Z");
    await subject.addFlight(flight);
    await subject.occupy(flight.id, ALL_BUSINESS);

    assert.equal(await subject.search.findDetails(crypto.randomUUID()), undefined);
    const details = await subject.search.findDetails(flight.id);
    assert.deepEqual(details?.availability.map((entry) => [entry.fareClass, entry.availableSeats]), [
      ["ECONOMY", 18],
      ["BUSINESS", 0],
    ]);
  });
}
