import assert from "node:assert/strict";
import test from "node:test";

import { createGetFlight } from "../src/flights/get-flight.js";
import type { FlightSearch } from "../src/flights/flight-search.js";
import type { Flight } from "../src/types.js";
import {
  createInMemoryFlightRepository,
  createInMemoryFlightSearch,
  createInMemoryFlightStore,
} from "./fakes/in-memory.js";
import {
  FIXTURE_DESTINATION,
  FIXTURE_LONDON,
  FIXTURE_ORIGIN,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight,
  TEST_AIRPORTS,
} from "./fixtures/flights.js";

const NOW = new Date("2026-10-10T00:00:00.000Z");
const FLIGHT: Flight = makeFlight({
  id: "f1a9e2c0-0000-4000-8000-000000000001",
  departureAt: "2027-01-02T16:00:00.000Z", // 23:00 in Vietnam
  arrivalAt: "2027-01-02T22:00:00.000Z", // 05:00 the next day
});

async function withFlights(...flights: Flight[]) {
  const store = createInMemoryFlightStore();
  const repository = createInMemoryFlightRepository(store);
  for (const flight of flights) {
    await repository.create(flight);
  }
  return { store, repository, flightSearch: createInMemoryFlightSearch(store, TEST_AIRPORTS) };
}

test("an existing flight is found with its availability per class and local times; a flight across midnight arrives +1", async () => {
  const { flightSearch } = await withFlights(FLIGHT);

  const result = await createGetFlight({ flightSearch, getCurrentTime: () => NOW })(FLIGHT.id);

  assert.deepEqual(result, {
    outcome: "found",
    flight: {
      ...FLIGHT,
      departureLocal: "2027-01-02T23:00:00+07:00",
      arrivalLocal: "2027-01-03T05:00:00+07:00",
      arrivalDayOffset: 1,
      availability: [{ fareClass: "ECONOMY", availableSeats: 120, fare: FLIGHT.fares.ECONOMY }],
    },
  });
});

test("each end is in its own zone: SGN 08:00 → London lands 15:00 BST the same day in summer", async () => {
  const toLondon = makeFlight({
    id: "f1a9e2c0-0000-4000-8000-000000000003",
    originAirportId: FIXTURE_ORIGIN.id,
    origin: FIXTURE_ORIGIN.code,
    destinationAirportId: FIXTURE_LONDON.id,
    destination: FIXTURE_LONDON.code,
    departureAt: "2027-06-10T01:00:00.000Z",
    arrivalAt: "2027-06-10T14:00:00.000Z",
  });
  const { flightSearch } = await withFlights(toLondon);

  const result = await createGetFlight({ flightSearch, getCurrentTime: () => NOW })(toLondon.id);

  assert.equal(result.outcome, "found");
  if (result.outcome !== "found") return;
  assert.deepEqual(
    [result.flight.departureLocal, result.flight.arrivalLocal, result.flight.arrivalDayOffset],
    ["2027-06-10T08:00:00+07:00", "2027-06-10T15:00:00+01:00", 0],
  );
  assert.equal(result.flight.destination, FIXTURE_LONDON.code);
  assert.notEqual(result.flight.destination, FIXTURE_DESTINATION.code);
});

test("availability counts free seats per class, the same seats the seat map shows", async () => {
  const twoClass = makeFlight({ id: "f1a9e2c0-0000-4000-8000-000000000004", aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID });
  const { store, repository, flightSearch } = await withFlights(twoClass);
  for (const seat of store.seats.get(twoClass.id)!.slice(0, 3)) {
    seat.status = "BOOKED";
    seat.bookingId = crypto.randomUUID();
  }

  const result = await createGetFlight({ flightSearch, getCurrentTime: () => NOW })(twoClass.id);
  const seatMap = (await repository.findSeats(twoClass.id))!;
  const free = (fareClass: string) =>
    seatMap.filter((seat) => seat.fareClass === fareClass && seat.status === "AVAILABLE").length;

  assert.equal(result.outcome, "found");
  if (result.outcome !== "found") return;
  assert.deepEqual(
    result.flight.availability.map((entry) => [entry.fareClass, entry.availableSeats]),
    [
      ["ECONOMY", free("ECONOMY")],
      ["BUSINESS", free("BUSINESS")],
    ],
  );
  assert.equal(result.flight.availableSeats, free("ECONOMY") + free("BUSINESS"));
});

test("the status read is the effective one: OPEN within 1 hour of departure reads CLOSED", async () => {
  const flight = makeFlight({
    id: "f1a9e2c0-0000-4000-8000-000000000002",
    status: "OPEN",
    departureAt: "2026-10-10T00:30:00.000Z",
    arrivalAt: "2026-10-10T02:30:00.000Z",
  });
  const { repository, flightSearch } = await withFlights(flight);

  const result = await createGetFlight({ flightSearch, getCurrentTime: () => NOW })(flight.id);

  assert.equal(result.outcome === "found" && result.flight.status, "CLOSED");
  // Derived on read, never written back (ADR-008).
  assert.equal((await repository.findById(flight.id))?.status, "OPEN");
});

test("an unknown uuid is not-found", async () => {
  const { flightSearch } = await withFlights();
  const getFlight = createGetFlight({ flightSearch, getCurrentTime: () => NOW });

  assert.deepEqual(await getFlight("c0ffee00-0000-4000-8000-000000000000"), { outcome: "not-found" });
});

test("a malformed id is not-found without asking the read port", async () => {
  let lookups = 0;
  const flightSearch: FlightSearch = {
    async search() {
      return { items: [], hasNextPage: false };
    },
    async findDetails() {
      lookups += 1;
      return undefined;
    },
  };
  const getFlight = createGetFlight({ flightSearch, getCurrentTime: () => NOW });

  assert.deepEqual(await getFlight("not-a-uuid"), { outcome: "not-found" });
  assert.equal(lookups, 0);
});
