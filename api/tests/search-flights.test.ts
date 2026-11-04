import assert from "node:assert/strict";
import test from "node:test";

import type { FlightSearch } from "../src/flights/flight-search.js";
import { createSearchFlights } from "../src/flights/search-flights.js";
import {
  createInMemoryFlightRepository,
  createInMemoryFlightSearch,
  createInMemoryFlightStore,
} from "./fakes/in-memory.js";
import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight,
  TEST_AIRPORTS,
} from "./fixtures/flights.js";

const NOW = new Date("2027-01-01T00:00:00.000Z");
const RANGE = {
  origin: FIXTURE_ORIGIN.code,
  destination: FIXTURE_DESTINATION.code,
  departureDateFrom: "2027-03-10",
  departureDateTo: "2027-03-16",
};

/**
 * 15 flights: three aircraft at the same minute on each of 5 days (ties on
 * departure), and a few two-class flights whose economy is sold out (ties
 * and differences on price).
 */
async function world() {
  const store = createInMemoryFlightStore();
  const repository = createInMemoryFlightRepository(store);
  for (let day = 10; day <= 14; day += 1) {
    for (const aircraftId of [FIXTURE_AIRCRAFT_ID, FIXTURE_OTHER_AIRCRAFT_ID, FIXTURE_TWO_CLASS_AIRCRAFT_ID]) {
      const departure = Date.UTC(2027, 2, day, 1, 0, 0);
      const flight = makeFlight({
        aircraftId,
        departureAt: new Date(departure).toISOString(),
        arrivalAt: new Date(departure + 2 * 3600_000).toISOString(),
      });
      await repository.create(flight);
      if (aircraftId === FIXTURE_TWO_CLASS_AIRCRAFT_ID && day % 2 === 0) {
        for (const seat of store.seats.get(flight.id) ?? []) {
          if (seat.fareClass === "ECONOMY") {
            seat.status = "BOOKED";
            seat.bookingId = crypto.randomUUID();
          }
        }
      }
    }
  }
  return { store, flightSearch: createInMemoryFlightSearch(store, TEST_AIRPORTS) };
}

async function walk(searchFlights: ReturnType<typeof createSearchFlights>, query: Record<string, string>) {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    const result = await searchFlights({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(result.outcome, "success", JSON.stringify(result));
    if (result.outcome !== "success") return ids;
    ids.push(...result.items.map((item) => item.id));
    if (!result.page.hasNextPage) {
      assert.equal(result.page.nextCursor, null);
      return ids;
    }
    assert.ok(result.page.nextCursor);
    cursor = result.page.nextCursor;
  }
  throw new Error("more than 100 pages");
}

test("walking every page gives exactly the unpaginated result — no duplicate, no gap, same order — for page sizes 1, 2, 7 and more than the total, by departure and by price", async () => {
  const { flightSearch } = await world();
  const searchFlights = createSearchFlights({ flightSearch, getCurrentTime: () => NOW });

  for (const sort of ["departure", "price"]) {
    const all = await searchFlights({ ...RANGE, sort, limit: "50" });
    assert.equal(all.outcome, "success");
    const expected = all.outcome === "success" ? all.items.map((item) => item.id) : [];
    assert.equal(expected.length, 15);

    for (const limit of ["1", "2", "7", "40"]) {
      assert.deepEqual(await walk(searchFlights, { ...RANGE, sort, limit }), expected, `${sort}, limit ${limit}`);
    }
  }
});

test("a cursor is only good for the search that made it: other passengers or sort → invalid_cursor", async () => {
  const { flightSearch } = await world();
  const searchFlights = createSearchFlights({ flightSearch, getCurrentTime: () => NOW });
  const first = await searchFlights({ ...RANGE, limit: "2" });
  assert.equal(first.outcome, "success");
  const cursor = first.outcome === "success" ? first.page.nextCursor ?? "" : "";

  assert.deepEqual(await searchFlights({ ...RANGE, limit: "2", cursor, passengers: "2" }), { outcome: "invalid_cursor" });
  assert.deepEqual(await searchFlights({ ...RANGE, limit: "2", cursor, sort: "price" }), { outcome: "invalid_cursor" });
  assert.equal((await searchFlights({ ...RANGE, limit: "5", cursor })).outcome, "success", "the page size is not part of the search");
});

test("invalid parameters win over a bad cursor, and the port is not called for either", async () => {
  let calls = 0;
  const flightSearch: FlightSearch = {
    async search() {
      calls += 1;
      return { items: [], hasNextPage: false };
    },
    async findDetails() {
      return undefined;
    },
  };
  const searchFlights = createSearchFlights({ flightSearch, getCurrentTime: () => NOW });

  const invalid = await searchFlights({ ...RANGE, passengers: "10", cursor: "garbage" });
  assert.equal(invalid.outcome, "validation_failed");
  assert.deepEqual(await searchFlights({ ...RANGE, cursor: "garbage" }), { outcome: "invalid_cursor" });
  assert.equal(calls, 0);
});

test("no flights is a success with an empty page, not an error (US-FLT-04)", async () => {
  const { flightSearch } = await world();
  const searchFlights = createSearchFlights({ flightSearch, getCurrentTime: () => NOW });

  assert.deepEqual(await searchFlights({ ...RANGE, departureDateFrom: "2027-04-01", departureDateTo: "2027-04-01" }), {
    outcome: "success",
    items: [],
    page: { hasNextPage: false, nextCursor: null },
  });
});
