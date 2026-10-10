import assert from "node:assert/strict";
import test from "node:test";

import {
  createListFlights,
} from "../src/flights/list-flights.js";
import type {
  FlightPageRequest,
  FlightRepository,
} from "../src/flights/flight-repository.js";
import type { Flight } from "../src/types.js";
import { makeFlight as makeFixtureFlight } from "./fixtures/flights.js";

const NOW = new Date("2026-10-10T00:00:00.000Z");

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return makeFixtureFlight({ id: "flight-1", availableSeats: 120, ...overrides });
}

function makeRepository(
  overrides: Partial<FlightRepository> = {},
): FlightRepository {
  return {
    async findPage() {
      return {
        items: [],
        totalItems: 0,
      };
    },
    async findById() {
      return undefined;
    },
    async create() {
      return {
        outcome: "created",
      };
    },
    async changeStatus() {
      return { outcome: "not-found" };
    },
    ...overrides,
  };
}

test("uses default pagination values", async () => {
  let receivedRequest: FlightPageRequest | undefined;

  const repository = makeRepository({
    async findPage(request) {
      receivedRequest = request;
      return {
        items: [],
        totalItems: 0,
      };
    },
  });

  const listFlights = createListFlights({
    flightRepository: repository,
    getCurrentTime: () => NOW,
  });

  const result = await listFlights({});

  assert.deepEqual(receivedRequest, {
    limit: 20,
    offset: 0,
  });

  assert.deepEqual(result, {
    outcome: "success",
    items: [],
    pagination: {
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    },
  });
});

test("converts page and pageSize to limit and offset", async () => {
  let receivedRequest: FlightPageRequest | undefined;

  const repository = makeRepository({
    async findPage(request) {
      receivedRequest = request;
      return {
        items: [],
        totalItems: 45,
      };
    },
  });

  const listFlights = createListFlights({
    flightRepository: repository,
    getCurrentTime: () => NOW,
  });

  const result = await listFlights({
    page: "3",
    pageSize: "10",
  });

  assert.deepEqual(receivedRequest, {
    limit: 10,
    offset: 20,
  });

  assert.equal(result.outcome, "success");
  if (result.outcome === "success") {
    assert.equal(result.pagination.page, 3);
    assert.equal(result.pagination.pageSize, 10);
    assert.equal(result.pagination.totalItems, 45);
    assert.equal(result.pagination.totalPages, 5);
  }
});

test("rejects invalid pagination values without calling repository", async (t) => {
  const cases = [
    {
      name: "page zero",
      query: { page: "0" },
      expectedCode: "INVALID_PAGE",
    },
    {
      name: "negative page",
      query: { page: "-1" },
      expectedCode: "INVALID_PAGE",
    },
    {
      name: "decimal page",
      query: { page: "1.5" },
      expectedCode: "INVALID_PAGE",
    },
    {
      name: "text page",
      query: { page: "abc" },
      expectedCode: "INVALID_PAGE",
    },
    {
      name: "pageSize too large",
      query: { pageSize: "101" },
      expectedCode: "INVALID_PAGE_SIZE",
    },
    {
      name: "repeated page values",
      query: { page: ["1", "2"] },
      expectedCode: "INVALID_PAGE",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let callCount = 0;

      const repository = makeRepository({
        async findPage() {
          callCount += 1;
          return {
            items: [],
            totalItems: 0,
          };
        },
      });

      const listFlights = createListFlights({
        flightRepository: repository,
        getCurrentTime: () => NOW,
      });

      const result = await listFlights(testCase.query);

      assert.equal(result.outcome, "validation_failed");
      assert.equal(callCount, 0);

      if (result.outcome === "validation_failed") {
        assert.ok(
          result.issues.some(
            (issue) => issue.code === testCase.expectedCode,
          ),
        );
      }
    });
  }
});

test("calculates total pages from total items", async () => {
  const flights = [
    makeFlight({ id: "flight-1" }),
    makeFlight({ id: "flight-2" }),
  ];

  const repository = makeRepository({
    async findPage() {
      return {
        items: flights,
        totalItems: 45,
      };
    },
  });

  const listFlights = createListFlights({
    flightRepository: repository,
    getCurrentTime: () => NOW,
  });

  const result = await listFlights({
    page: "2",
    pageSize: "20",
  });

  assert.equal(result.outcome, "success");

  if (result.outcome === "success") {
    assert.equal(result.pagination.totalPages, 3);
    assert.equal(result.pagination.totalItems, 45);
  }
});

test("every flight on the page carries its effective status", async () => {
  const flights = [
    makeFlight({ id: "scheduled", status: "SCHEDULED" }),
    makeFlight({
      id: "closing",
      status: "OPEN",
      departureAt: "2026-10-10T00:59:59.000Z",
      arrivalAt: "2026-10-10T02:00:00.000Z",
    }),
    makeFlight({
      id: "departed",
      status: "OPEN",
      departureAt: "2026-10-09T22:00:00.000Z",
      arrivalAt: "2026-10-10T00:00:00.000Z",
    }),
    makeFlight({ id: "cancelled", status: "CANCELLED" }),
  ];

  const listFlights = createListFlights({
    flightRepository: makeRepository({
      async findPage() {
        return { items: flights, totalItems: flights.length };
      },
    }),
    getCurrentTime: () => NOW,
  });

  const result = await listFlights({});

  assert.equal(result.outcome, "success");
  if (result.outcome === "success") {
    assert.deepEqual(
      result.items.map((flight) => [flight.id, flight.status]),
      [
        ["scheduled", "SCHEDULED"],
        ["closing", "CLOSED"],
        ["departed", "DEPARTED"],
        ["cancelled", "CANCELLED"],
      ],
    );
  }
});

test("propagates unexpected repository failures", async () => {
  const repository = makeRepository({
    async findPage() {
      throw new Error("database failure");
    },
  });

  const listFlights = createListFlights({
    flightRepository: repository,
    getCurrentTime: () => NOW,
  });

  await assert.rejects(() => listFlights({}), /database failure/);
});
