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

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
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

function makeRepository(
  overrides: Partial<FlightRepository> = {},
): FlightRepository {
  return {
    findPage() {
      return {
        items: [],
        totalItems: 0,
      };
    },
    findById() {
      return undefined;
    },
    create() {
      return {
        outcome: "created",
      };
    },
    ...overrides,
  };
}

test("uses default pagination values", () => {
  let receivedRequest: FlightPageRequest | undefined;

  const repository = makeRepository({
    findPage(request) {
      receivedRequest = request;
      return {
        items: [],
        totalItems: 0,
      };
    },
  });

  const listFlights = createListFlights({
    flightRepository: repository,
  });

  const result = listFlights({});

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

test("converts page and pageSize to limit and offset", () => {
  let receivedRequest: FlightPageRequest | undefined;

  const repository = makeRepository({
    findPage(request) {
      receivedRequest = request;
      return {
        items: [],
        totalItems: 45,
      };
    },
  });

  const listFlights = createListFlights({
    flightRepository: repository,
  });

  const result = listFlights({
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
    await t.test(testCase.name, () => {
      let callCount = 0;

      const repository = makeRepository({
        findPage() {
          callCount += 1;
          return {
            items: [],
            totalItems: 0,
          };
        },
      });

      const listFlights = createListFlights({
        flightRepository: repository,
      });

      const result = listFlights(testCase.query);

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

test("calculates total pages from total items", () => {
  const flights = [
    makeFlight({ id: "flight-1" }),
    makeFlight({ id: "flight-2" }),
  ];

  const repository = makeRepository({
    findPage() {
      return {
        items: flights,
        totalItems: 45,
      };
    },
  });

  const listFlights = createListFlights({
    flightRepository: repository,
  });

  const result = listFlights({
    page: "2",
    pageSize: "20",
  });

  assert.equal(result.outcome, "success");

  if (result.outcome === "success") {
    assert.equal(result.pagination.totalPages, 3);
    assert.equal(result.pagination.totalItems, 45);
  }
});

test("propagates unexpected repository failures", () => {
  const repository = makeRepository({
    findPage() {
      throw new Error("database failure");
    },
  });

  const listFlights = createListFlights({
    flightRepository: repository,
  });

  assert.throws(() => listFlights({}), /database failure/);
});
