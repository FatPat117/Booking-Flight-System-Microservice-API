import assert from "node:assert/strict";
import test from "node:test";

import type {
  Aircraft,
  AircraftRepository,
} from "../../src/aircraft/aircraft-repository.js";
import { expandSeatLayout } from "../../src/aircraft/seat-layout.js";

/**
 * What every AircraftRepository promises, run against the in-memory fake
 * (unit tier) and Postgres (integration tier). Not a *.test.ts file: it
 * registers tests only when a runner file calls it.
 */
function makeAircraft(registration: string): Aircraft {
  const layout = expandSeatLayout({
    cabins: [
      { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
      { fareClass: "ECONOMY", fromRow: 3, toRow: 7, seatLetters: "ABCDEF" },
    ],
  });
  assert.ok(layout.success);

  return {
    id: crypto.randomUUID(),
    registration,
    model: "Airbus A321",
    createdAt: "2026-10-10T00:00:00.000Z",
    seats: layout.value,
  };
}

export function runAircraftRepositoryContract(
  implementation: string,
  setup: () => Promise<AircraftRepository>,
): void {
  const name = (behavior: string) =>
    `AircraftRepository contract (${implementation}): ${behavior}`;

  test(name("a created aircraft is read back with every seat and fare class"), async () => {
    const repository = await setup();
    const aircraft = makeAircraft("VN-A321");

    assert.deepEqual(await repository.create(aircraft), { outcome: "created" });

    const stored = await repository.findById(aircraft.id);
    assert.deepEqual(stored, aircraft);
    assert.equal(stored?.seats.length, 38);
    assert.equal(
      stored?.seats.filter((seat) => seat.fareClass === "BUSINESS").length,
      8,
    );
  });

  test(name("seats are read back ordered by row, then letter"), async () => {
    const repository = await setup();
    const aircraft = makeAircraft("VN-A322");

    await repository.create({
      ...aircraft,
      seats: [...aircraft.seats].reverse(),
    });

    const stored = await repository.findById(aircraft.id);
    assert.deepEqual(stored?.seats, aircraft.seats);
  });

  test(name("a taken registration is duplicate and the first aircraft is unchanged (BR-REF-02)"), async () => {
    const repository = await setup();
    const first = makeAircraft("VN-A323");

    await repository.create(first);
    const second = { ...makeAircraft("VN-A323"), seats: first.seats.slice(0, 1) };

    assert.deepEqual(await repository.create(second), { outcome: "duplicate" });
    assert.equal(await repository.findById(second.id), undefined);
    assert.deepEqual(await repository.findById(first.id), first);
  });

  test(name("two aircraft may both have seat 12A — positions are unique per aircraft only"), async () => {
    const repository = await setup();
    const one = makeAircraft("VN-A324");
    const two = makeAircraft("VN-A325");

    assert.deepEqual(await repository.create(one), { outcome: "created" });
    assert.deepEqual(await repository.create(two), { outcome: "created" });
  });

  test(name("a layout with a duplicated position throws and stores nothing (BR-REF-03)"), async () => {
    const repository = await setup();
    const aircraft = makeAircraft("VN-A326");
    const firstSeat = aircraft.seats[0];
    assert.ok(firstSeat);

    await assert.rejects(
      repository.create({ ...aircraft, seats: [...aircraft.seats, firstSeat] }),
    );
    assert.equal(await repository.findById(aircraft.id), undefined);
  });

  test(name("findByRegistration returns the aircraft with its seats, or undefined"), async () => {
    const repository = await setup();
    const aircraft = makeAircraft("VN-A327");
    await repository.create(aircraft);

    assert.deepEqual(await repository.findByRegistration("VN-A327"), aircraft);
    assert.equal(await repository.findByRegistration("VN-A999"), undefined);
  });

  test(name("an unknown id is undefined"), async () => {
    const repository = await setup();

    assert.equal(await repository.findById(crypto.randomUUID()), undefined);
  });
}
