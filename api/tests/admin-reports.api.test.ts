import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import request from "supertest";

import { parseSeatPosition } from "../src/aircraft/seat-position.js";
import { createApp } from "../src/app.js";
import type { AuditRecorder } from "../src/audit/audit-recorder.js";
import type { Logger, LogFields } from "../src/observability/logger.js";
import { createGetFlightManifest } from "../src/reports/get-flight-manifest.js";
import { createGetLoadFactor } from "../src/reports/get-load-factor.js";
import { createQueryAuditLog } from "../src/reports/query-audit-log.js";
import type { Flight } from "../src/types.js";
import { makeBooking, passengersFor } from "./fixtures/bookings.js";
import { FIXTURE_TWO_CLASS_AIRCRAFT_ID, makeFlight, TEST_AIRPORTS } from "./fixtures/flights.js";
import {
  createInMemoryAdminReports,
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryHealthChecks,
  createInMemoryTransactionRunner,
  createUnusedBookingReads,
  createUnusedFlightSeatMap,
  createUnusedOpenFlight,
  createUnusedPayForBooking,
  createUnusedReferenceData,
} from "./fakes/in-memory.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";
const NOW = new Date("2026-10-10T00:00:00.000Z");
const ADMIN_ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_ACCOUNT = "11111111-1111-4111-8111-111111111111";

function token(sub: string, role: "user" | "admin"): string {
  return jwt.sign({ sub, email: `${role}@example.com`, role }, TEST_JWT_SECRET, { expiresIn: "1h" });
}
const ADMIN = token(ADMIN_ACCOUNT, "admin");
const USER = token(USER_ACCOUNT, "user");
const as = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

/**
 * The three report routes on the real use cases and the AdminReports fake,
 * with a flight holding two CONFIRMED passengers and one valid hold. The
 * logger keeps every line, so a test can look for personal data in it.
 */
async function createContext(options: { auditRecorder?: AuditRecorder } = {}) {
  const store = createInMemoryFlightStore();
  const flights = createInMemoryFlightRepository(store);
  const bookings = createInMemoryBookingRepository({ flights: store });
  const audit = createInMemoryAuditRecorder();
  const transactionRunner = createInMemoryTransactionRunner();
  const lines: Array<{ message: string; fields?: LogFields }> = [];
  const push = (message: string, fields?: LogFields) => {
    lines.push(fields === undefined ? { message } : { message, fields });
  };
  const logger: Logger = { info: push, warn: push, error: push };

  const flight: Flight = makeFlight({
    aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID,
    departureAt: "2027-02-01T01:00:00.000Z",
    arrivalAt: "2027-02-01T03:00:00.000Z",
  });
  assert.deepEqual(await flights.create(flight), { outcome: "created" });

  const holdExpiresAt = new Date(NOW.getTime() + 15 * 60_000).toISOString();
  async function hold(seats: string[], names: string[]) {
    const booking = makeBooking({ flightId: flight.id, holdExpiresAt });
    const held = await bookings.holdSeats(
      flight.id,
      booking.id,
      { kind: "chosen", seats: seats.map((code) => parseSeatPosition(code)!) },
      NOW,
    );
    assert.equal(held.outcome, "held");
    if (held.outcome !== "held") throw new Error("not held");
    await bookings.create({ ...booking, passengers: passengersFor(held.seats, names) });
    return booking;
  }
  const paid = await hold(["3A", "3B"], ["Nguyen Thi Hoa", "Tran Van Binh"]);
  assert.equal((await bookings.confirmHold(paid.id, { kind: "admin" }, NOW)).outcome, "confirmed");
  await hold(["4A"], ["Pending Person"]);

  const adminReports = createInMemoryAdminReports({ flights: store, bookings, audit, airports: TEST_AIRPORTS });
  const app = createApp({
    getFlight: async () => ({ outcome: "not-found" }),
    getFlightSeatMap: createUnusedFlightSeatMap().getFlightSeatMap,
    createFlight: async () => ({ outcome: "duplicate" }),
    ...createUnusedOpenFlight(),
    createBooking: async () => ({ outcome: "flight-not-found" }),
    cancelBooking: async () => ({ outcome: "not-found" }),
    changeSeat: async () => ({ outcome: "not-found" }),
    ...createUnusedPayForBooking(),
    ...createUnusedBookingReads(),
    listFlights: async () => ({
      outcome: "success",
      items: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    }),
    searchFlights: async () => ({ outcome: "success" as const, items: [], page: { hasNextPage: false, nextCursor: null } }),
    ...createUnusedReferenceData(),
    getFlightManifest: createGetFlightManifest({
      adminReports,
      auditRecorder: options.auditRecorder ?? audit,
      transactionRunner,
      generateAuditId: () => crypto.randomUUID(),
      getRequestId: () => "request-1",
      getCurrentTime: () => NOW,
    }),
    getLoadFactor: createGetLoadFactor({ adminReports, getCurrentTime: () => NOW }),
    queryAuditLog: createQueryAuditLog({ adminReports }),
    logger,
    healthChecks: createInMemoryHealthChecks(),
    jwtSecret: TEST_JWT_SECRET,
  });

  return { app, audit, flight, paid, lines };
}

const REPORTS = (flightId: string) => [
  `/api/admin/flights/${flightId}/manifest`,
  "/api/admin/reports/load-factor?dateFrom=2027-02-01&dateTo=2027-02-01",
  `/api/admin/audit-logs?targetType=flight&targetId=${flightId}`,
];

test("every report answers 401 without a token and 403 to a user (Decision 19)", async () => {
  const { app, flight } = await createContext();
  for (const path of REPORTS(flight.id)) {
    assert.equal((await request(app).get(path)).status, 401, path);
    const forbidden = await request(app).get(path).set(as(USER));
    assert.equal(forbidden.status, 403, path);
    assert.equal(forbidden.body.error.code, "FORBIDDEN", path);
  }
});

test("GET manifest answers the flight, its seats per class and only the CONFIRMED passengers, with exactly four fields each", async () => {
  const { app, flight, paid } = await createContext();

  const response = await request(app).get(`/api/admin/flights/${flight.id}/manifest`).set(as(ADMIN));

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ["classes", "flight", "heldBookings", "passengers"]);
  assert.deepEqual(response.body.flight, {
    id: flight.id,
    flightNumber: flight.flightNumber,
    origin: flight.origin,
    destination: flight.destination,
    departureAt: flight.departureAt,
    departureLocal: "2027-02-01T08:00:00+07:00",
    status: "OPEN",
  });
  assert.deepEqual(response.body.classes, [
    { fareClass: "BUSINESS", total: 12, booked: 0, held: 0, available: 12 },
    { fareClass: "ECONOMY", total: 18, booked: 2, held: 1, available: 15 },
  ]);
  assert.equal(response.body.heldBookings, 1);
  assert.deepEqual(response.body.passengers, [
    { reference: paid.reference, name: "Nguyen Thi Hoa", seat: "3A", fareClass: "ECONOMY" },
    { reference: paid.reference, name: "Tran Van Binh", seat: "3B", fareClass: "ECONOMY" },
  ]);
  assert.ok(!JSON.stringify(response.body).includes("Pending Person"), "a HELD booking is counted, never named");
});

test("each manifest view is audited by the admin with the count and no name; the request's log lines name no passenger", async () => {
  const { app, audit, flight, lines } = await createContext();

  await request(app).get(`/api/admin/flights/${flight.id}/manifest`).set(as(ADMIN));

  assert.deepEqual(
    audit.records.map(({ action, actor, target, requestId, metadata }) => ({ action, actor, target, requestId, metadata })),
    [
      {
        action: "FLIGHT_MANIFEST_VIEWED",
        actor: { type: "account", id: ADMIN_ACCOUNT },
        target: { type: "flight", id: flight.id },
        requestId: "request-1",
        metadata: { passengerCount: 2 },
      },
    ],
  );
  assert.ok(lines.length > 0, "the request was logged");
  const logged = JSON.stringify(lines);
  for (const name of ["Nguyen Thi Hoa", "Tran Van Binh", "Pending Person"]) {
    assert.ok(!logged.includes(name), `${name} reached a log line`);
  }
});

test("GET manifest of an unknown or malformed flight id is 404 and audits nothing", async () => {
  const { app, audit } = await createContext();
  for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
    const response = await request(app).get(`/api/admin/flights/${id}/manifest`).set(as(ADMIN));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "FLIGHT_NOT_FOUND");
  }
  assert.equal(audit.records.length, 0);
});

test("when the view cannot be audited, the manifest is not sent: 500 without a passenger in the body", async () => {
  const { app, flight } = await createContext({
    auditRecorder: {
      async record() {
        throw new Error("audit store down");
      },
    },
  });

  const response = await request(app).get(`/api/admin/flights/${flight.id}/manifest`).set(as(ADMIN));

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "INTERNAL_SERVER_ERROR");
  assert.ok(!JSON.stringify(response.body).includes("Nguyen Thi Hoa"));
});

test("GET load factor answers each class with sold, held, available and the ratio; bad parameters are 422", async () => {
  const { app, flight } = await createContext();

  const response = await request(app)
    .get("/api/admin/reports/load-factor?dateFrom=2027-02-01&dateTo=2027-02-01")
    .set(as(ADMIN));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.page, { hasNextPage: false, nextCursor: null });
  assert.equal(response.body.items[0].id, flight.id);
  assert.deepEqual(response.body.items[0].classes, [
    { fareClass: "BUSINESS", total: 12, sold: 0, held: 0, available: 12, loadFactor: 0 },
    { fareClass: "ECONOMY", total: 18, sold: 2, held: 1, available: 15, loadFactor: 0.1111 },
  ]);

  const invalid = await request(app)
    .get("/api/admin/reports/load-factor?dateFrom=2027-02-01&dateTo=2027-03-05")
    .set(as(ADMIN));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.details[0].code, "DATE_RANGE_TOO_LONG");
});

test("GET audit log needs a target or a range (422), pages with a cursor, and refuses a cursor of another filter (400)", async () => {
  const { app, flight } = await createContext();
  for (let index = 0; index < 3; index += 1) {
    await request(app).get(`/api/admin/flights/${flight.id}/manifest`).set(as(ADMIN));
  }

  const unfiltered = await request(app).get("/api/admin/audit-logs?action=FLIGHT_MANIFEST_VIEWED").set(as(ADMIN));
  assert.equal(unfiltered.status, 422);
  assert.equal(unfiltered.body.error.details[0].code, "FILTER_REQUIRED");

  const path = `/api/admin/audit-logs?targetType=flight&targetId=${flight.id}&limit=2`;
  const first = await request(app).get(path).set(as(ADMIN));
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 2);
  assert.equal(first.body.page.hasNextPage, true);
  const second = await request(app)
    .get(`${path}&cursor=${first.body.page.nextCursor as string}`)
    .set(as(ADMIN));
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.page.nextCursor, null);

  const foreign = await request(app)
    .get(`/api/admin/audit-logs?targetType=flight&targetId=${crypto.randomUUID()}&cursor=${first.body.page.nextCursor as string}`)
    .set(as(ADMIN));
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error.code, "INVALID_CURSOR");
});
