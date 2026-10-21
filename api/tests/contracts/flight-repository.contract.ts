import assert from "node:assert/strict";
import test from "node:test";

import type { FlightRepository } from "../../src/flights/flight-repository.js";
import { vnd } from "../../src/money/money.js";
import type { Flight } from "../../src/types.js";
import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight,
} from "../fixtures/flights.js";

/**
 * What every FlightRepository promises (Day 46), run against the in-memory
 * fake (unit tier) and Postgres (integration tier). The aircraft-schedule
 * cases matter most: Postgres decides them with an exclusion constraint and
 * a SQL function, the fake with TypeScript arithmetic — the boundary cases
 * below keep the two from drifting (45-minute turnaround, half-open window,
 * cancelled flights ignored).
 *
 * The subject's storage must already hold the fixture airports and aircraft
 * (tests/fixtures/flights.ts). Not a *.test.ts file: it registers tests only
 * when a runner file calls it.
 */
const MINUTE_MS = 60 * 1000;

/** A flight on `aircraftId` departing `offsetMinutes` after a fixed base, lasting 2 h. */
function scheduled(
  aircraftId: string,
  offsetMinutes: number,
  overrides: Partial<Flight> = {},
): Flight {
  const departure = Date.UTC(2028, 0, 10, 8, 0, 0) + offsetMinutes * MINUTE_MS;
  return makeFlight({
    aircraftId,
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + 120 * MINUTE_MS).toISOString(),
    status: "SCHEDULED",
    ...overrides,
  });
}

export function runFlightRepositoryContract(
  implementation: string,
  setup: () => Promise<FlightRepository>,
): void {
  const name = (behavior: string) =>
    `FlightRepository contract (${implementation}): ${behavior}`;

  test(name("a created flight reads back with its references, codes and status"), async () => {
    const repository = await setup();
    const flight = scheduled(FIXTURE_AIRCRAFT_ID, 0);

    assert.deepEqual(await repository.create(flight), { outcome: "created" });

    const stored = await repository.findById(flight.id);
    assert.deepEqual(stored, flight);
    assert.equal(stored?.origin, FIXTURE_ORIGIN.code);
    assert.equal(stored?.destination, FIXTURE_DESTINATION.code);
  });

  test(name("a created flight's seats read back in (row, letter) order, all AVAILABLE"), async () => {
    const repository = await setup();
    const flight = scheduled(FIXTURE_OTHER_AIRCRAFT_ID, 0); // 5 seats

    await repository.create(flight);

    assert.deepEqual(
      await repository.findSeats(flight.id),
      ["A", "B", "C", "D", "E"].map((letter) => ({
        position: { row: 1, letter },
        fareClass: "ECONOMY",
        status: "AVAILABLE",
      })),
    );
  });

  test(name("a two-class flight's fares read back as numbers of đồng, and its seats keep their class"), async () => {
    const repository = await setup();
    const flight = scheduled(FIXTURE_TWO_CLASS_AIRCRAFT_ID, 0, {
      fares: { ECONOMY: vnd(1_500_000), BUSINESS: vnd(Number.MAX_SAFE_INTEGER) },
    });

    await repository.create(flight);

    const stored = await repository.findById(flight.id);
    // bigint arrives from pg as a string; it must come back an exact number.
    assert.deepEqual(stored?.fares, flight.fares);
    assert.equal(typeof stored?.fares.BUSINESS?.amount, "number");
    const seats = (await repository.findSeats(flight.id)) ?? [];
    assert.deepEqual(
      [seats[0]?.fareClass, seats.at(-1)?.fareClass],
      ["BUSINESS", "ECONOMY"],
    );
  });

  test(name("each flight on a page reads back its own fares"), async () => {
    const repository = await setup();
    const cheap = scheduled(FIXTURE_AIRCRAFT_ID, 0, {
      fares: { ECONOMY: vnd(900_000) },
    });
    const dear = scheduled(FIXTURE_OTHER_AIRCRAFT_ID, 0, {
      fares: { ECONOMY: vnd(2_100_000) },
    });
    await repository.create(cheap);
    await repository.create(dear);

    const page = await repository.findPage({ limit: 100, offset: 0 });
    const fareOf = (id: string) =>
      page.items.find((item) => item.id === id)?.fares;

    assert.deepEqual(fareOf(cheap.id), cheap.fares);
    assert.deepEqual(fareOf(dear.id), dear.fares);
  });

  test(name("findSeats of an unknown flight is undefined, not an empty list"), async () => {
    const repository = await setup();

    assert.equal(await repository.findSeats(crypto.randomUUID()), undefined);
  });

  test(name("the same flight number at the same instant is duplicate (BR-FLT-04)"), async () => {
    const repository = await setup();
    const first = scheduled(FIXTURE_AIRCRAFT_ID, 0);
    await repository.create(first);

    // Another aircraft, so only the flight-number rule can object.
    const again = scheduled(FIXTURE_OTHER_AIRCRAFT_ID, 0, {
      flightNumber: first.flightNumber,
    });

    assert.deepEqual(await repository.create(again), { outcome: "duplicate" });
  });

  test(name("an overlapping flight on the same aircraft is aircraft-unavailable (BR-FLT-03)"), async () => {
    const repository = await setup();
    await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, 0));
    const overlapping = scheduled(FIXTURE_AIRCRAFT_ID, 60);

    assert.deepEqual(await repository.create(overlapping), {
      outcome: "aircraft-unavailable",
    });
    assert.equal(await repository.findById(overlapping.id), undefined);
  });

  test(name("turnaround: departing exactly 45 min after arrival is allowed (half-open window)"), async () => {
    const repository = await setup();
    await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, 0)); // lands at +120

    assert.deepEqual(
      await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, 120 + 45)),
      { outcome: "created" },
    );
  });

  test(name("turnaround: departing 44 min after arrival is aircraft-unavailable (BR-FLT-08)"), async () => {
    const repository = await setup();
    await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, 0));

    assert.deepEqual(
      await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, 120 + 44)),
      { outcome: "aircraft-unavailable" },
    );
  });

  test(name("the window also blocks a flight that ends inside it (earlier departure)"), async () => {
    const repository = await setup();
    await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, 0));

    // Departs 2 h 30 earlier, lands at -30, aircraft busy until +15.
    assert.deepEqual(
      await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, -150)),
      { outcome: "aircraft-unavailable" },
    );
  });

  test(name("another aircraft may fly at the same time"), async () => {
    const repository = await setup();
    await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, 0));

    assert.deepEqual(
      await repository.create(scheduled(FIXTURE_OTHER_AIRCRAFT_ID, 0)),
      { outcome: "created" },
    );
  });

  test(name("a cancelled flight frees its aircraft's window"), async () => {
    const repository = await setup();
    await repository.create(
      scheduled(FIXTURE_AIRCRAFT_ID, 0, { status: "CANCELLED" }),
    );

    assert.deepEqual(
      await repository.create(scheduled(FIXTURE_AIRCRAFT_ID, 30)),
      { outcome: "created" },
    );
  });

  test(name("changeStatus changes the status when it is still the expected one"), async () => {
    const repository = await setup();
    const flight = scheduled(FIXTURE_AIRCRAFT_ID, 0);
    await repository.create(flight);

    assert.deepEqual(await repository.changeStatus(flight.id, "SCHEDULED", "OPEN"), {
      outcome: "changed",
    });
    assert.equal((await repository.findById(flight.id))?.status, "OPEN");
  });

  test(name("changeStatus from a stale status is status-changed with the current one"), async () => {
    const repository = await setup();
    const flight = scheduled(FIXTURE_AIRCRAFT_ID, 0);
    await repository.create(flight);
    await repository.changeStatus(flight.id, "SCHEDULED", "OPEN");

    assert.deepEqual(await repository.changeStatus(flight.id, "SCHEDULED", "OPEN"), {
      outcome: "status-changed",
      current: "OPEN",
    });
  });

  test(name("changeStatus on an unknown flight is not-found"), async () => {
    const repository = await setup();

    assert.deepEqual(
      await repository.changeStatus(crypto.randomUUID(), "SCHEDULED", "OPEN"),
      { outcome: "not-found" },
    );
  });
}
