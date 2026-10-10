import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

import { createApp } from "../src/app.js";
import { createRegisterAircraft } from "../src/aircraft/register-aircraft.js";
import { createListAirports } from "../src/airports/list-airports.js";
import { createRegisterAirport } from "../src/airports/register-airport.js";
import { createGetFlight } from "../src/flights/get-flight.js";
import { createListFlights } from "../src/flights/list-flights.js";
import type { Logger } from "../src/observability/logger.js";
import {
  createInMemoryAircraftRepository,
  createInMemoryAirportRepository,
  createInMemoryAuditRecorder,
  createInMemoryFlightRepository,
  createInMemoryHealthChecks,
  createInMemoryTransactionRunner,
  createUnusedBookingReads,
  createUnusedOpenFlight,
  type InMemoryAuditRecorder,
} from "./fakes/in-memory.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";
const FIXED_TIME = new Date("2026-10-10T00:00:00.000Z");
const ADMIN_ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";

function token(role: "user" | "admin"): string {
  return jwt.sign(
    { sub: ADMIN_ACCOUNT, email: `${role}@example.com`, role },
    TEST_JWT_SECRET,
    { expiresIn: "1h" },
  );
}

const ADMIN = token("admin");
const USER = token("user");

const DAD = {
  code: "dad",
  name: "Da Nang International",
  city: "Da Nang",
  timeZone: "Asia/Ho_Chi_Minh",
};

const A321 = {
  registration: "VN-A321",
  model: "Airbus A321",
  seatLayout: {
    cabins: [
      { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
      { fareClass: "ECONOMY", fromRow: 3, toRow: 7, seatLetters: "ABCDEF" },
    ],
  },
};

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function createContext(): { app: Express; audit: InMemoryAuditRecorder } {
  const flightRepository = createInMemoryFlightRepository();
  const airportRepository = createInMemoryAirportRepository();
  const aircraftRepository = createInMemoryAircraftRepository();
  const audit = createInMemoryAuditRecorder();
  const common = {
    auditRecorder: audit,
    transactionRunner: createInMemoryTransactionRunner(),
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  };

  const app = createApp({
    getFlight: createGetFlight({
      flightRepository,
      getCurrentTime: () => FIXED_TIME,
    }),
    listFlights: createListFlights({
      flightRepository,
      getCurrentTime: () => FIXED_TIME,
    }),
    createFlight: async () => ({ outcome: "duplicate" }),
    ...createUnusedOpenFlight(),
    createBooking: async () => ({ outcome: "flight-not-found" }),
    cancelBooking: async () => ({ outcome: "not-found" }),
    ...createUnusedBookingReads(),
    registerAirport: createRegisterAirport({ ...common, airportRepository }),
    listAirports: createListAirports({ airportRepository }),
    registerAircraft: createRegisterAircraft({ ...common, aircraftRepository }),
    logger: silentLogger,
    healthChecks: createInMemoryHealthChecks(),
    jwtSecret: TEST_JWT_SECRET,
  });

  return { app, audit };
}

function postAs(app: Express, path: string, bearer: string | undefined) {
  const builder = request(app).post(path);
  return bearer === undefined
    ? builder
    : builder.set("Authorization", `Bearer ${bearer}`);
}

test("write routes need a token (401) and the admin role (403)", async () => {
  const { app, audit } = createContext();

  for (const [path, body] of [
    ["/api/airports", DAD],
    ["/api/aircraft", A321],
  ] as const) {
    const anonymous = await postAs(app, path, undefined).send(body);
    assert.equal(anonymous.status, 401, path);

    const user = await postAs(app, path, USER).send(body);
    assert.equal(user.status, 403, path);
    assert.equal(user.body.error.code, "FORBIDDEN", path);
  }

  assert.equal(audit.records.length, 0);
});

test("POST /api/airports sends sgn and gets SGN back (201), then 409 on the same code", async () => {
  const { app, audit } = createContext();

  const created = await postAs(app, "/api/airports", ADMIN).send(DAD);

  assert.equal(created.status, 201);
  assert.equal(created.body.code, "DAD");
  assert.equal(created.body.timeZone, "Asia/Ho_Chi_Minh");
  assert.equal(created.headers.location, undefined);
  assert.deepEqual(audit.records[0]?.actor, {
    type: "account",
    id: ADMIN_ACCOUNT,
  });

  const duplicate = await postAs(app, "/api/airports", ADMIN).send({
    ...DAD,
    code: "DAD",
  });

  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "AIRPORT_ALREADY_EXISTS");
});

test("POST /api/airports rejects an unknown time zone with 422 naming the field", async () => {
  const { app } = createContext();

  const response = await postAs(app, "/api/airports", ADMIN).send({
    ...DAD,
    timeZone: "Asia/Not_A_Zone",
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
  assert.deepEqual(
    response.body.error.details.map((issue: { field: string }) => issue.field),
    ["timeZone"],
  );
});

test("GET /api/airports is public, ordered by code and paged", async () => {
  const { app } = createContext();

  for (const code of ["SGN", "HAN", "DAD"]) {
    await postAs(app, "/api/airports", ADMIN).send({ ...DAD, code });
  }

  const response = await request(app).get("/api/airports?pageSize=2");

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.items.map((airport: { code: string }) => airport.code),
    ["DAD", "HAN"],
  );
  assert.deepEqual(response.body.pagination, {
    page: 1,
    pageSize: 2,
    totalItems: 3,
    totalPages: 2,
  });

  const invalid = await request(app).get("/api/airports?page=0");
  assert.equal(invalid.status, 422);
});

test("POST /api/aircraft returns seat counts per fare class (201), then 409 on the same registration", async () => {
  const { app, audit } = createContext();

  const created = await postAs(app, "/api/aircraft", ADMIN).send({
    ...A321,
    registration: "vn-a321",
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.registration, "VN-A321");
  assert.equal(created.body.seatCount, 38);
  assert.deepEqual(created.body.seatsByFareClass, { ECONOMY: 30, BUSINESS: 8 });
  assert.equal(created.body.seats, undefined);
  assert.equal(audit.records[0]?.action, "AIRCRAFT_REGISTERED");

  const duplicate = await postAs(app, "/api/aircraft", ADMIN).send(A321);

  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "AIRCRAFT_ALREADY_EXISTS");
});

test("POST /api/aircraft with overlapping cabins is 422 naming the duplicated seat 12A", async () => {
  const { app, audit } = createContext();

  const response = await postAs(app, "/api/aircraft", ADMIN).send({
    ...A321,
    seatLayout: {
      cabins: [
        { fareClass: "BUSINESS", fromRow: 1, toRow: 12, seatLetters: "ACDF" },
        { fareClass: "ECONOMY", fromRow: 12, toRow: 30, seatLetters: "ABCDEF" },
      ],
    },
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.details[0].code, "CABIN_ROWS_OVERLAP");
  assert.match(response.body.error.details[0].message, /12A/);
  assert.equal(audit.records.length, 0);
});

test("POST /api/aircraft asking for a billion rows is 422 (input amplification)", async () => {
  const { app } = createContext();

  const response = await postAs(app, "/api/aircraft", ADMIN).send({
    ...A321,
    seatLayout: {
      cabins: [
        { fareClass: "ECONOMY", fromRow: 1, toRow: 1_000_000_000, seatLetters: "ABCDEF" },
      ],
    },
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.details[0].code, "INVALID_ROW");
});
