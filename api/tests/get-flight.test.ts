import assert from "node:assert/strict";
import test from "node:test";

import { createGetFlight } from "../src/flights/get-flight.js";
import type { Flight } from "../src/types.js";
import { createInMemoryFlightRepository } from "./fakes/in-memory.js";

const FLIGHT: Flight = {
  id: "f1a9e2c0-0000-4000-8000-000000000001",
  flightNumber: "VN123",
  origin: "SGN",
  destination: "HAN",
  departureAt: "2026-11-10T01:00:00.000Z",
  arrivalAt: "2026-11-10T03:10:00.000Z",
  priceInCents: 1_500_000,
  currency: "VND",
  availableSeats: 38,
};

test("an existing flight is found", async () => {
  const flightRepository = createInMemoryFlightRepository();
  await flightRepository.create(FLIGHT);

  const result = await createGetFlight({ flightRepository })(FLIGHT.id);

  assert.deepEqual(result, { outcome: "found", flight: FLIGHT });
});

test("an unknown uuid is not-found", async () => {
  const getFlight = createGetFlight({
    flightRepository: createInMemoryFlightRepository(),
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
  });

  assert.deepEqual(await getFlight("not-a-uuid"), { outcome: "not-found" });
  assert.equal(lookups, 0);
});
