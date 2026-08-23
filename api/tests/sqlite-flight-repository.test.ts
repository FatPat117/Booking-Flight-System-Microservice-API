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

test("findPage returns empty page for a new repository", (t) => {
  const repository = createRepo(t);

  const result = repository.findPage({
    limit: 20,
    offset: 0,
  });

  assert.deepEqual(result, {
    items: [],
    totalItems: 0,
  });
});

test("create then findById returns the same Flight in camelCase", (t) => {
  const repository = createRepo(t);
  const flight = makeFlight({ id: "flight-1" });

  const result = repository.create(flight);
  assert.equal(result.outcome, "created");

  const found = repository.findById("flight-1");
  assert.deepEqual(found, flight);
  assert.equal(
    (found as Flight & { flight_number?: string }).flight_number,
    undefined,
  );
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

  const page = repository.findPage({
    limit: 20,
    offset: 0,
  });

  assert.equal(page.items.length, 1);
  assert.equal(page.totalItems, 1);
  assert.equal(repository.findById("a")?.id, "a");
  assert.equal(repository.findById("b"), undefined);
});

test("findPage returns ordered pages with totalItems", (t) => {
  const repository = createRepo(t);

  repository.create(
    makeFlight({
      id: "flight-5",
      flightNumber: "VN105",
      departureAt: "2026-08-15T01:00:00.000Z",
      arrivalAt: "2026-08-15T03:00:00.000Z",
    }),
  );
  repository.create(
    makeFlight({
      id: "flight-1",
      flightNumber: "VN101",
      departureAt: "2026-08-11T01:00:00.000Z",
      arrivalAt: "2026-08-11T03:00:00.000Z",
    }),
  );
  repository.create(
    makeFlight({
      id: "flight-4",
      flightNumber: "VN104",
      departureAt: "2026-08-14T01:00:00.000Z",
      arrivalAt: "2026-08-14T03:00:00.000Z",
    }),
  );
  repository.create(
    makeFlight({
      id: "flight-2",
      flightNumber: "VN102",
      departureAt: "2026-08-12T01:00:00.000Z",
      arrivalAt: "2026-08-12T03:00:00.000Z",
    }),
  );
  repository.create(
    makeFlight({
      id: "flight-3",
      flightNumber: "VN103",
      departureAt: "2026-08-13T01:00:00.000Z",
      arrivalAt: "2026-08-13T03:00:00.000Z",
    }),
  );

  const firstPage = repository.findPage({
    limit: 2,
    offset: 0,
  });

  assert.equal(firstPage.totalItems, 5);
  assert.deepEqual(
    firstPage.items.map((flight) => flight.id),
    ["flight-1", "flight-2"],
  );

  const secondPage = repository.findPage({
    limit: 2,
    offset: 2,
  });

  assert.deepEqual(
    secondPage.items.map((flight) => flight.id),
    ["flight-3", "flight-4"],
  );

  const lastPage = repository.findPage({
    limit: 2,
    offset: 4,
  });

  assert.deepEqual(
    lastPage.items.map((flight) => flight.id),
    ["flight-5"],
  );

  const beyondEnd = repository.findPage({
    limit: 2,
    offset: 20,
  });

  assert.deepEqual(beyondEnd.items, []);
  assert.equal(beyondEnd.totalItems, 5);
});
