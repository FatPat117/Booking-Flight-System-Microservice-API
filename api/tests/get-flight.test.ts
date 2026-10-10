import assert from "node:assert/strict";
import test from "node:test";

import { createGetFlight } from "../src/flights/get-flight.js";
import type { Flight } from "../src/types.js";
import { createInMemoryFlightRepository } from "./fakes/in-memory.js";
import { makeFlight } from "./fixtures/flights.js";

const NOW = new Date("2026-10-10T00:00:00.000Z");
const FLIGHT: Flight = makeFlight({ id: "f1a9e2c0-0000-4000-8000-000000000001" });

test("an existing flight is found", async () => {
  const flightRepository = createInMemoryFlightRepository();
  await flightRepository.create(FLIGHT);

  const result = await createGetFlight({
    flightRepository,
    getCurrentTime: () => NOW,
  })(FLIGHT.id);

  assert.deepEqual(result, { outcome: "found", flight: FLIGHT });
});

test("the status read is the effective one: OPEN within 1 hour of departure reads CLOSED", async () => {
  const flightRepository = createInMemoryFlightRepository();
  const flight = makeFlight({
    id: "f1a9e2c0-0000-4000-8000-000000000002",
    status: "OPEN",
    departureAt: "2026-10-10T00:30:00.000Z",
    arrivalAt: "2026-10-10T02:30:00.000Z",
  });
  await flightRepository.create(flight);

  const result = await createGetFlight({
    flightRepository,
    getCurrentTime: () => NOW,
  })(flight.id);

  assert.deepEqual(result, {
    outcome: "found",
    flight: { ...flight, status: "CLOSED" },
  });
  // Derived on read, never written back (ADR-008).
  assert.equal((await flightRepository.findById(flight.id))?.status, "OPEN");
});

test("an unknown uuid is not-found", async () => {
  const getFlight = createGetFlight({
    flightRepository: createInMemoryFlightRepository(),
    getCurrentTime: () => NOW,
  });

  assert.deepEqual(
    await getFlight("c0ffee00-0000-4000-8000-000000000000"),
    { outcome: "not-found" },
  );
});

test("a malformed id is not-found without asking the repository", async () => {
  let lookups = 0;
  const getFlight = createGetFlight({
    flightRepository: {
      ...createInMemoryFlightRepository(),
      async findById() {
        lookups += 1;
        return undefined;
      },
    },
    getCurrentTime: () => NOW,
  });

  assert.deepEqual(await getFlight("not-a-uuid"), { outcome: "not-found" });
  assert.equal(lookups, 0);
});
