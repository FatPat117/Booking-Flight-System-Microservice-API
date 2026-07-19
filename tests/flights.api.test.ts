import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import request from "supertest";

import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import type { FlightRepository } from "../src/flights/flight-repository.js";
import { createListFlights } from "../src/flights/list-flights.js";
import { createSqliteFlightRepository } from "../src/flights/sqlite-flight-repository.js";
import type { Logger, LogFields } from "../src/observability/logger.js";

type FlightPayload = {
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  priceInCents: number;
  currency: string;
  availableSeats: number;
  [key: string]: unknown;
};

function createMemoryLogger() {
  const entries: Array<{
    level: string;
    message: string;
    fields?: LogFields;
  }> = [];

  const logger: Logger = {
    info(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "info", message }
          : { level: "info", message, fields },
      );
    },
    warn(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "warn", message }
          : { level: "warn", message, fields },
      );
    },
    error(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "error", message }
          : { level: "error", message, fields },
      );
    },
  };

  return { logger, entries };
}

function makeValidFlight(
  overrides: Partial<FlightPayload> = {},
): FlightPayload {
  return {
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T08:00:00+07:00",
    arrivalAt: "2026-08-10T10:00:00+07:00",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 120,
    ...overrides,
  };
}

function createAppWithRepository(flightRepository: FlightRepository) {
  const createFlight = createCreateFlight({
    flightRepository,
    generateId: () => crypto.randomUUID(),
  });

  const listFlights = createListFlights({
    flightRepository,
  });

  const { logger } = createMemoryLogger();

  return createApp({
    flightRepository,
    createFlight,
    listFlights,
    logger,
  });
}

function createTestContext(t: TestContext): {
  app: Express;
  database: DatabaseSync;
  repository: FlightRepository;
} {
  const database = openDatabase(":memory:");
  const repository = createSqliteFlightRepository(database);
  const app = createAppWithRepository(repository);

  t.after(() => {
    database.close();
  });

  return { app, database, repository };
}

async function postRawJson(app: Express, rawJson: string) {
  return request(app)
    .post("/api/flights")
    .set("Content-Type", "application/json")
    .send(rawJson);
}

function assertValidationFailed(
  body: unknown,
  expectedIssueCode?: string,
  expectedField?: string,
) {
  assert.ok(body && typeof body === "object");
  const error = (body as { error?: Record<string, unknown> }).error;
  assert.ok(error);
  assert.equal(error.code, "VALIDATION_FAILED");
  assert.ok(Array.isArray(error.details));

  if (expectedIssueCode) {
    const details = error.details as Array<{ code: string; field: string }>;
    const match = details.find(
      (issue) =>
        issue.code === expectedIssueCode &&
        (expectedField === undefined || issue.field === expectedField),
    );
    assert.ok(
      match,
      `Expected issue code ${expectedIssueCode}` +
        (expectedField ? ` on field ${expectedField}` : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// Health & reads
// ---------------------------------------------------------------------------

test("GET /health returns application health", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("GET /api/flights returns an empty paginated collection", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app).get("/api/flights");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    items: [],
    pagination: {
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    },
  });
});

test("GET /api/flights/:id returns 404 for missing flight", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app).get("/api/flights/not-found-id");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Successful creation contract
// ---------------------------------------------------------------------------

test("POST /api/flights creates a normalized flight with Location header", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app)
    .post("/api/flights")
    .send(
      makeValidFlight({
        flightNumber: "vn123",
        origin: " sgn ",
        destination: "han",
        currency: "vnd",
        isAdmin: true,
        internalStatus: "APPROVED",
      }),
    );

  assert.equal(response.status, 201);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);

  assert.equal(typeof response.body.id, "string");
  assert.ok(response.body.id.length > 0);
  assert.equal(response.headers.location, `/api/flights/${response.body.id}`);

  assert.equal(response.body.flightNumber, "VN123");
  assert.equal(response.body.origin, "SGN");
  assert.equal(response.body.destination, "HAN");
  assert.equal(response.body.currency, "VND");
  assert.equal(response.body.departureAt, "2026-08-10T01:00:00.000Z");
  assert.equal(response.body.arrivalAt, "2026-08-10T03:00:00.000Z");
  assert.equal(response.body.priceInCents, 15_000_000);
  assert.equal(response.body.availableSeats, 120);
  assert.equal(response.body.isAdmin, undefined);
  assert.equal(response.body.internalStatus, undefined);
  assert.equal(response.body.flight_number, undefined);

  const getResponse = await request(app).get(
    `/api/flights/${response.body.id}`,
  );
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.id, response.body.id);
  assert.equal(getResponse.body.flightNumber, "VN123");
});

test("POST /api/flights accepts availableSeats = 0", async (t) => {
  const { app } = createTestContext(t);

  const response = await request(app)
    .post("/api/flights")
    .send(makeValidFlight({ availableSeats: 0 }));

  assert.equal(response.status, 201);
  assert.equal(response.body.availableSeats, 0);
});

// ---------------------------------------------------------------------------
// Top-level body shape
// ---------------------------------------------------------------------------

test("rejects valid JSON primitives and arrays with INVALID_BODY", async (t) => {
  const cases = [
    { name: "null", raw: "null" },
    { name: "string", raw: '"hello"' },
    { name: "number", raw: "123" },
    { name: "array", raw: "[]" },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (sub) => {
      const { app } = createTestContext(sub);
      const response = await postRawJson(app, testCase.raw);

      assert.equal(response.status, 422);
      assertValidationFailed(response.body, "INVALID_BODY", "body");
    });
  }
});

test("malformed JSON returns 400 MALFORMED_JSON as JSON", async (t) => {
  const { app } = createTestContext(t);
  const response = await postRawJson(app, '{"flightNumber":');

  assert.equal(response.status, 400);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  assert.equal(response.body.error.code, "MALFORMED_JSON");
  assert.equal(typeof response.body.error.message, "string");
  assert.equal(response.body.error.stack, undefined);
  assert.equal(response.body.stack, undefined);
  assert.ok(!JSON.stringify(response.body).includes("flightNumber"));
});

test("GET /api/unknown returns 404 ROUTE_NOT_FOUND", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app).get("/api/unknown");

  assert.equal(response.status, 404);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
});

test("PUT /api/flights currently resolves as ROUTE_NOT_FOUND", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app)
    .put("/api/flights")
    .send(makeValidFlight());

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
});

test("unexpected errors return generic 500 without leaking internals", async () => {
  const express = (await import("express")).default;
  const { createErrorHandler } = await import("../src/http-errors.js");
  const { logger } = createMemoryLogger();

  const testApp = express();
  testApp.get("/boom", () => {
    throw new Error("sensitive internal message");
  });
  testApp.use(createErrorHandler(logger));

  const response = await request(testApp).get("/boom");

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "INTERNAL_SERVER_ERROR");
  assert.equal(typeof response.body.error.message, "string");
  assert.ok(
    !JSON.stringify(response.body).includes("sensitive internal message"),
  );
  assert.equal(response.body.error.stack, undefined);
  assert.equal(response.body.stack, undefined);
});

// ---------------------------------------------------------------------------
// Required fields & primitive types
// ---------------------------------------------------------------------------

test("rejects empty object with missing fields", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app).post("/api/flights").send({});

  assert.equal(response.status, 422);
  assertValidationFailed(response.body);
  assert.ok(response.body.error.details.length >= 8);
});

test("rejects wrong primitive types and empty strings", async (t) => {
  const cases = [
    {
      name: "number instead of string flightNumber",
      override: { flightNumber: 123 as unknown as string },
      code: "INVALID_STRING",
      field: "flightNumber",
    },
    {
      name: "string instead of number priceInCents",
      override: { priceInCents: "15000000" as unknown as number },
      code: "INVALID_PRICE",
      field: "priceInCents",
    },
    {
      name: "whitespace-only origin",
      override: { origin: "   " },
      code: "INVALID_STRING",
      field: "origin",
    },
    {
      name: "fractional price",
      override: { priceInCents: 10.5 },
      code: "INVALID_PRICE",
      field: "priceInCents",
    },
    {
      name: "negative seats",
      override: { availableSeats: -1 },
      code: "INVALID_AVAILABLE_SEATS",
      field: "availableSeats",
    },
    {
      name: "unsafe integer price",
      override: { priceInCents: Number.MAX_SAFE_INTEGER + 1 },
      code: "INVALID_PRICE",
      field: "priceInCents",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (sub) => {
      const { app } = createTestContext(sub);
      const response = await request(app)
        .post("/api/flights")
        .send(makeValidFlight(testCase.override));

      assert.equal(response.status, 422);
      assertValidationFailed(response.body, testCase.code, testCase.field);
    });
  }
});

// ---------------------------------------------------------------------------
// Business invariants
// ---------------------------------------------------------------------------

test("rejects business invariant violations", async (t) => {
  const cases = [
    {
      name: "origin equals destination",
      override: { origin: "SGN", destination: "sgn" },
      code: "ORIGIN_EQUALS_DESTINATION",
    },
    {
      name: "arrival before departure",
      override: {
        departureAt: "2026-08-10T10:00:00Z",
        arrivalAt: "2026-08-10T08:00:00Z",
      },
      code: "ARRIVAL_BEFORE_DEPARTURE",
    },
    {
      name: "arrival equals departure",
      override: {
        departureAt: "2026-08-10T08:00:00Z",
        arrivalAt: "2026-08-10T08:00:00Z",
      },
      code: "ARRIVAL_BEFORE_DEPARTURE",
    },
    {
      name: "unsupported currency",
      override: { currency: "EUR" },
      code: "UNSUPPORTED_CURRENCY",
    },
    {
      name: "invalid airport code",
      override: { origin: "SAIGON" },
      code: "INVALID_AIRPORT_CODE",
      field: "origin",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (sub) => {
      const { app } = createTestContext(sub);
      const response = await request(app)
        .post("/api/flights")
        .send(makeValidFlight(testCase.override));

      assert.equal(response.status, 422);
      assertValidationFailed(
        response.body,
        testCase.code,
        "field" in testCase ? testCase.field : undefined,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Calendar edge cases
// ---------------------------------------------------------------------------

test("calendar date validation", async (t) => {
  const rejectCases = [
    {
      name: "rejects non-leap Feb 29 2026",
      departureAt: "2026-02-29T08:00:00Z",
      arrivalAt: "2026-02-29T10:00:00Z",
    },
    {
      name: "rejects Feb 30",
      departureAt: "2026-02-30T08:00:00Z",
      arrivalAt: "2026-03-02T10:00:00Z",
    },
    {
      name: "rejects Apr 31",
      departureAt: "2026-04-31T08:00:00Z",
      arrivalAt: "2026-05-01T10:00:00Z",
    },
    {
      name: "rejects month 13",
      departureAt: "2026-13-01T08:00:00Z",
      arrivalAt: "2026-13-01T10:00:00Z",
    },
    {
      name: "rejects hour 25",
      departureAt: "2026-01-01T25:00:00Z",
      arrivalAt: "2026-01-01T26:00:00Z",
    },
    {
      name: "rejects minute 60",
      departureAt: "2026-01-01T08:60:00Z",
      arrivalAt: "2026-01-01T10:00:00Z",
    },
    {
      name: "rejects second 60",
      departureAt: "2026-01-01T08:00:60Z",
      arrivalAt: "2026-01-01T10:00:00Z",
    },
  ];

  for (const testCase of rejectCases) {
    await t.test(testCase.name, async (sub) => {
      const { app } = createTestContext(sub);
      const response = await request(app)
        .post("/api/flights")
        .send(
          makeValidFlight({
            departureAt: testCase.departureAt,
            arrivalAt: testCase.arrivalAt,
          }),
        );

      assert.equal(response.status, 422);
      assertValidationFailed(response.body, "INVALID_DATETIME");
    });
  }

  await t.test("accepts leap day 2028-02-29", async (sub) => {
    const { app } = createTestContext(sub);
    const response = await request(app)
      .post("/api/flights")
      .send(
        makeValidFlight({
          departureAt: "2028-02-29T08:00:00Z",
          arrivalAt: "2028-02-29T10:00:00Z",
        }),
      );

    assert.equal(response.status, 201);
    assert.equal(response.body.departureAt, "2028-02-29T08:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Duplicate & mutation safety
// ---------------------------------------------------------------------------

test("duplicate flightNumber + departure instant returns 409 and keeps one record", async (t) => {
  const { app } = createTestContext(t);

  const first = await request(app).post("/api/flights").send(makeValidFlight());
  assert.equal(first.status, 201);

  const second = await request(app)
    .post("/api/flights")
    .send(
      makeValidFlight({
        flightNumber: "vn123",
        departureAt: "2026-08-10T01:00:00Z",
        arrivalAt: "2026-08-10T03:00:00Z",
      }),
    );

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "FLIGHT_ALREADY_EXISTS");

  const list = await request(app).get("/api/flights");
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.pagination.totalItems, 1);
});

test("invalid request does not mutate collection", async (t) => {
  const { app } = createTestContext(t);

  const before = await request(app).get("/api/flights");
  assert.equal(before.body.items.length, 0);

  const invalid = await request(app).post("/api/flights").send({});
  assert.equal(invalid.status, 422);

  const after = await request(app).get("/api/flights");
  assert.equal(after.body.items.length, 0);
});

// ---------------------------------------------------------------------------
// Isolation via separate databases
// ---------------------------------------------------------------------------

test("isolation A: creating a flight does not leak across memory databases", async (t) => {
  const { app } = createTestContext(t);
  const created = await request(app)
    .post("/api/flights")
    .send(makeValidFlight());
  assert.equal(created.status, 201);

  const list = await request(app).get("/api/flights");
  assert.equal(list.body.items.length, 1);
});

test("isolation B: fresh memory database starts empty", async (t) => {
  const { app } = createTestContext(t);
  const list = await request(app).get("/api/flights");

  assert.equal(list.status, 200);
  assert.deepEqual(list.body, {
    items: [],
    pagination: {
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    },
  });
});

test("repository unexpected failure returns generic 500 without leaking internals", async () => {
  const failingRepository: FlightRepository = {
    findPage() {
      throw new Error("sensitive database failure");
    },
    findById() {
      throw new Error("sensitive database failure");
    },
    create() {
      throw new Error("sensitive database failure");
    },
  };

  const app = createAppWithRepository(failingRepository);
  const response = await request(app).get("/api/flights");

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "INTERNAL_SERVER_ERROR");
  assert.ok(
    !JSON.stringify(response.body).includes("sensitive database failure"),
  );
});

// ---------------------------------------------------------------------------
// Persistence (file-backed)
// ---------------------------------------------------------------------------

test("flight persists after closing and reopening the same database file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "booking-persist-"));
  const databasePath = join(dir, "booking.db");

  let db1: DatabaseSync | undefined;
  let db2: DatabaseSync | undefined;

  try {
    db1 = openDatabase(databasePath);
    const app1 = createAppWithRepository(createSqliteFlightRepository(db1));

    const created = await request(app1)
      .post("/api/flights")
      .send(makeValidFlight({ flightNumber: "VN999" }));

    assert.equal(created.status, 201);
    const createdId = created.body.id as string;

    db1.close();
    db1 = undefined;

    db2 = openDatabase(databasePath);
    const app2 = createAppWithRepository(createSqliteFlightRepository(db2));

    const listed = await request(app2).get("/api/flights");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].id, createdId);
    assert.equal(listed.body.items[0].flightNumber, "VN999");
    assert.equal(listed.body.pagination.totalItems, 1);

    const byId = await request(app2).get(`/api/flights/${createdId}`);
    assert.equal(byId.status, 200);
    assert.equal(byId.body.flightNumber, "VN999");
  } finally {
    db1?.close();
    db2?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two apps sharing one database file see the same source of truth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "booking-shared-"));
  const databasePath = join(dir, "booking.db");

  let dbA: DatabaseSync | undefined;
  let dbB: DatabaseSync | undefined;

  try {
    dbA = openDatabase(databasePath);
    dbB = openDatabase(databasePath);
    const appA = createAppWithRepository(createSqliteFlightRepository(dbA));
    const appB = createAppWithRepository(createSqliteFlightRepository(dbB));

    const created = await request(appA)
      .post("/api/flights")
      .send(makeValidFlight({ flightNumber: "VN777" }));
    assert.equal(created.status, 201);

    const fromB = await request(appB).get(`/api/flights/${created.body.id}`);
    assert.equal(fromB.status, 200);
    assert.equal(fromB.body.flightNumber, "VN777");

    const duplicate = await request(appB)
      .post("/api/flights")
      .send(
        makeValidFlight({
          flightNumber: "VN777",
          departureAt: "2026-08-10T01:00:00Z",
          arrivalAt: "2026-08-10T03:00:00Z",
        }),
      );
    assert.equal(duplicate.status, 409);
  } finally {
    dbA?.close();
    dbB?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test("GET /api/flights returns the requested page", async (t) => {
  const { app } = createTestContext(t);

  const departures = [
    "2026-08-11T08:00:00Z",
    "2026-08-12T08:00:00Z",
    "2026-08-13T08:00:00Z",
    "2026-08-14T08:00:00Z",
    "2026-08-15T08:00:00Z",
  ];

  for (let index = 0; index < departures.length; index += 1) {
    const departureAt = departures[index]!;
    const arrivalDate = new Date(departureAt);
    arrivalDate.setUTCHours(arrivalDate.getUTCHours() + 2);

    const response = await request(app)
      .post("/api/flights")
      .send(
        makeValidFlight({
          flightNumber: `VN10${index + 1}`,
          departureAt,
          arrivalAt: arrivalDate.toISOString(),
        }),
      );

    assert.equal(response.status, 201);
  }

  const response = await request(app).get(
    "/api/flights?page=2&pageSize=2",
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  assert.deepEqual(
    response.body.items.map(
      (flight: { flightNumber: string }) => flight.flightNumber,
    ),
    ["VN103", "VN104"],
  );
  assert.deepEqual(response.body.pagination, {
    page: 2,
    pageSize: 2,
    totalItems: 5,
    totalPages: 3,
  });
});

test("GET /api/flights rejects invalid page", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app).get("/api/flights?page=0");

  assert.equal(response.status, 422);
  assertValidationFailed(response.body, "INVALID_PAGE", "page");
});

test("GET /api/flights rejects pageSize above maximum", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app).get("/api/flights?pageSize=101");

  assert.equal(response.status, 422);
  assertValidationFailed(response.body, "INVALID_PAGE_SIZE", "pageSize");
});

test("GET /api/flights rejects repeated page parameters", async (t) => {
  const { app } = createTestContext(t);
  const response = await request(app).get("/api/flights?page=1&page=2");

  assert.equal(response.status, 422);
  assertValidationFailed(response.body, "INVALID_PAGE", "page");
});

test("GET /api/flights returns an empty page beyond the end", async (t) => {
  const { app } = createTestContext(t);

  const created = await request(app)
    .post("/api/flights")
    .send(makeValidFlight());

  assert.equal(created.status, 201);

  const response = await request(app).get(
    "/api/flights?page=10&pageSize=2",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, []);
  assert.deepEqual(response.body.pagination, {
    page: 10,
    pageSize: 2,
    totalItems: 1,
    totalPages: 1,
  });
});
