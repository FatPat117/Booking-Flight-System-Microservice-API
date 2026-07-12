import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import { openDatabase } from "../src/database.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import type { Flight } from "../src/types.js";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: crypto.randomUUID(),
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T01:00:00.000Z",
    arrivalAt: "2026-08-10T03:00:00.000Z",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 120,
    ...overrides,
  };
}

function createRepo(t: TestContext) {
  const database = openDatabase(":memory:");
  const repository = createSqliteFlightRepository(database);

  t.after(() => {
    database.close();
  });

  return repository;
}

test("findAll returns empty array for a new repository", (t) => {
  const repository = createRepo(t);
  assert.deepEqual(repository.findAll(), []);
});

test("create then findById returns the same Flight in camelCase", (t) => {
  const repository = createRepo(t);
  const flight = makeFlight({ id: "flight-1" });

  const result = repository.create(flight);
  assert.equal(result.outcome, "created");

  const found = repository.findById("flight-1");
  assert.deepEqual(found, flight);
  assert.equal((found as Flight & { flight_number?: string }).flight_number, undefined);
});

test("duplicate create returns duplicate and leaves one row", (t) => {
  const repository = createRepo(t);
  const first = makeFlight({ id: "a" });
  const second = makeFlight({
    id: "b",
    flightNumber: "VN123",
    departureAt: "2026-08-10T01:00:00.000Z",
  });

  assert.equal(repository.create(first).outcome, "created");
  assert.equal(repository.create(second).outcome, "duplicate");
  assert.equal(repository.findAll().length, 1);
  assert.equal(repository.findById("a")?.id, "a");
  assert.equal(repository.findById("b"), undefined);
});

test("findAll orders by departureAt then id", (t) => {
  const repository = createRepo(t);

  repository.create(
    makeFlight({
      id: "later-a",
      departureAt: "2026-08-12T01:00:00.000Z",
      arrivalAt: "2026-08-12T03:00:00.000Z",
      flightNumber: "VN200",
    }),
  );
  repository.create(
    makeFlight({
      id: "earlier",
      departureAt: "2026-08-10T01:00:00.000Z",
      arrivalAt: "2026-08-10T03:00:00.000Z",
      flightNumber: "VN100",
    }),
  );
  repository.create(
    makeFlight({
      id: "later-b",
      departureAt: "2026-08-12T01:00:00.000Z",
      arrivalAt: "2026-08-12T04:00:00.000Z",
      flightNumber: "VN201",
    }),
  );

  const all = repository.findAll();
  assert.deepEqual(
    all.map((flight) => flight.id),
    ["earlier", "later-a", "later-b"],
  );
});
