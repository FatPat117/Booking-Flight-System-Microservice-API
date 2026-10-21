import assert from "node:assert/strict";
import test from "node:test";

import type { FlightRepository, FlightSeat } from "../src/flights/flight-repository.js";
import { createGetFlightSeatMap } from "../src/flights/get-flight-seat-map.js";
import { vnd } from "../src/money/money.js";
import type { FlightFares } from "../src/types.js";
import { makeFlight } from "./fixtures/flights.js";

const FLIGHT_ID = "f1a90000-0000-4000-8000-000000000001";
const FARES: FlightFares = { ECONOMY: vnd(1_500_000), BUSINESS: vnd(4_200_000) };

/** The flight exists exactly when findSeats says so, like Postgres. */
function makeRepository(findSeats: FlightRepository["findSeats"]): FlightRepository {
  const unused = async (): Promise<never> => {
    throw new Error("not used by the seat map");
  };
  return {
    findPage: unused,
    async findById(id) {
      return (await findSeats(id)) === undefined
        ? undefined
        : makeFlight({ id, fares: FARES });
    },
    create: unused,
    changeStatus: unused,
    findSeats,
  };
}

test("a malformed flight id is not-found without asking the repository", async () => {
  let calls = 0;
  const getFlightSeatMap = createGetFlightSeatMap({
    flightRepository: makeRepository(async () => {
      calls += 1;
      return [];
    }),
  });

  assert.deepEqual(await getFlightSeatMap("not-a-uuid"), { outcome: "not-found" });
  assert.equal(calls, 0);
});

test("an unknown flight is not-found; a flight with no seats is an empty map", async () => {
  const unknown = createGetFlightSeatMap({ flightRepository: makeRepository(async () => undefined) });
  const seatless = createGetFlightSeatMap({ flightRepository: makeRepository(async () => []) });

  assert.deepEqual(await unknown(FLIGHT_ID), { outcome: "not-found" });
  assert.deepEqual(await seatless(FLIGHT_ID), {
    outcome: "found",
    seatMap: { flightId: FLIGHT_ID, fares: FARES, rows: [] },
  });
});

test("seats are grouped into rows of different widths, keeping the repository's order, with the fares once", async () => {
  const seats: FlightSeat[] = [
    { position: { row: 1, letter: "A" }, fareClass: "BUSINESS", status: "BOOKED" },
    { position: { row: 1, letter: "C" }, fareClass: "BUSINESS", status: "AVAILABLE" },
    { position: { row: 2, letter: "A" }, fareClass: "ECONOMY", status: "AVAILABLE" },
    { position: { row: 2, letter: "B" }, fareClass: "ECONOMY", status: "AVAILABLE" },
    { position: { row: 2, letter: "C" }, fareClass: "ECONOMY", status: "BOOKED" },
  ];
  const getFlightSeatMap = createGetFlightSeatMap({
    flightRepository: makeRepository(async () => seats),
  });

  assert.deepEqual(await getFlightSeatMap(FLIGHT_ID), {
    outcome: "found",
    seatMap: {
      flightId: FLIGHT_ID,
      fares: FARES,
      rows: [
        {
          row: 1,
          seats: [
            { code: "1A", fareClass: "BUSINESS", status: "BOOKED" },
            { code: "1C", fareClass: "BUSINESS", status: "AVAILABLE" },
          ],
        },
        {
          row: 2,
          seats: [
            { code: "2A", fareClass: "ECONOMY", status: "AVAILABLE" },
            { code: "2B", fareClass: "ECONOMY", status: "AVAILABLE" },
            { code: "2C", fareClass: "ECONOMY", status: "BOOKED" },
          ],
        },
      ],
    },
  });
});
