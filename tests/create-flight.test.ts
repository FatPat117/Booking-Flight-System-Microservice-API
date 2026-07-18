import assert from "node:assert/strict";
import test from "node:test";

import { createCreateFlight } from "../src/flights/create-flight.js";
import type { FlightRepository } from "../src/flights/flight-repository.js";
import type { Flight } from "../src/types.js";

function makeValidRawInput(overrides: Record<string, unknown> = {}) {
  return {
    flightNumber: "vn123",
    origin: " sgn ",
    destination: "han",
    departureAt: "2026-08-10T08:00:00+07:00",
    arrivalAt: "2026-08-10T10:00:00+07:00",
    priceInCents: 15_000_000,
    currency: "vnd",
    availableSeats: 120,
    ...overrides,
  };
}

test("valid input creates a normalized flight via repository", () => {
  const createdFlights: Flight[] = [];
  let generateIdCalls = 0;

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create(flight) {
      createdFlights.push(flight);
      return { outcome: "created" };
    },
  };

  const createFlight = createCreateFlight({
    flightRepository: repository,
    generateId: () => {
      generateIdCalls += 1;
      return "flight-fixed-id";
    },
  });

  const result = createFlight(makeValidRawInput());

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }

  assert.equal(result.flight.id, "flight-fixed-id");
  assert.equal(result.flight.flightNumber, "VN123");
  assert.equal(result.flight.origin, "SGN");
  assert.equal(result.flight.destination, "HAN");
  assert.equal(result.flight.currency, "VND");
  assert.equal(result.flight.departureAt, "2026-08-10T01:00:00.000Z");
  assert.equal(result.flight.arrivalAt, "2026-08-10T03:00:00.000Z");
  assert.equal(generateIdCalls, 1);
  assert.equal(createdFlights.length, 1);
  assert.deepEqual(createdFlights[0], result.flight);
});

test("invalid input does not generate ID or call repository", () => {
  let createCalls = 0;
  let generateIdCalls = 0;

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      createCalls += 1;
      return { outcome: "created" };
    },
  };

  const createFlight = createCreateFlight({
    flightRepository: repository,
    generateId: () => {
      generateIdCalls += 1;
      return "should-not-be-used";
    },
  });

  const result = createFlight({});

  assert.equal(result.outcome, "validation_failed");
  if (result.outcome !== "validation_failed") {
    return;
  }

  assert.ok(result.issues.length > 0);
  assert.equal(createCalls, 0);
  assert.equal(generateIdCalls, 0);
});

test("repository duplicate becomes application duplicate", () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "duplicate" };
    },
  };

  const createFlight = createCreateFlight({
    flightRepository: repository,
    generateId: () => "known-id",
  });

  const result = createFlight(makeValidRawInput());
  assert.equal(result.outcome, "duplicate");
});

test("ID generator value is passed to repository", () => {
  let persistedId: string | undefined;

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create(flight) {
      persistedId = flight.id;
      return { outcome: "created" };
    },
  };

  const createFlight = createCreateFlight({
    flightRepository: repository,
    generateId: () => "known-id",
  });

  createFlight(makeValidRawInput());
  assert.equal(persistedId, "known-id");
});

test("unexpected repository failure is not swallowed", () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      throw new Error("database failure");
    },
  };

  const createFlight = createCreateFlight({
    flightRepository: repository,
    generateId: () => "known-id",
  });

  assert.throws(
    () => createFlight(makeValidRawInput()),
    (error: unknown) =>
      error instanceof Error && error.message === "database failure",
  );
});
