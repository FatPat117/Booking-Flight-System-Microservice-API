import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createCreateBooking } from "../../src/bookings/create-booking.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { Flight } from "../../src/types.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { FIXTURE_FARES, makeFlight as makeFixtureFlight } from "../fixtures/flights.js";
import { insertFlightReferences, keepFirstSeats } from "./flight-references.js";

/**
 * Runs the real createCreateBooking use case wired to every Postgres
 * adapter (Flight + Booking + Audit + Outbox + TransactionRunner) — the
 * Day 38 create-flight.postgres.integration.test.ts pattern, applied to the
 * one use case that contends for shared rows (the flight's seats).
 */

const OWNER_ACTOR = { accountId: "11111111-1111-4111-8111-111111111111" };

let dataSource: DataSource;

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return makeFixtureFlight({ availableSeats: 1, ...overrides });
}

function createUseCase(generateReference: () => string = nextBookingReference) {
  return createCreateBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateId: () => crypto.randomUUID(),
    generateReference,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => "request-1",
    getCurrentTime: () => new Date("2026-07-20T00:00:00.000Z"),
  });
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

test("created: writes one booking row, claims its seat, one audit row, one outbox row", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ availableSeats: 1 });
  await flightRepository.create(flight);
  await keepFirstSeats(dataSource, flight.id, 1);

  const createBooking = createUseCase();
  const result = await createBooking(flight.id, { passengers: [{ name: "Alice" }] }, OWNER_ACTOR);

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }
  assert.deepEqual(result.booking.passengers, [
    { name: "Alice", seat: "1A", fareClass: "ECONOMY", price: FIXTURE_FARES.ECONOMY },
  ]);
  assert.deepEqual(result.booking.total, FIXTURE_FARES.ECONOMY);

  const seats = await dataSource.query(
    `SELECT "row" || "letter" AS seat, "status", "booking_id" FROM "flight_seats" WHERE "flight_id" = $1`,
    [flight.id],
  );
  assert.deepEqual(seats, [{ seat: "1A", status: "HELD", booking_id: result.booking.id }]);

  const bookingRows = (await dataSource.query(
    `SELECT id, flight_id, owner_account_id, status FROM bookings`,
  )) as Array<{
    id: string;
    flight_id: string;
    owner_account_id: string;
    status: string;
  }>;
  const auditRows = await dataSource.query(`SELECT id, target_id FROM audit_logs`);
  const outboxRows = (await dataSource.query(
    `SELECT id, event_type FROM outbox`,
  )) as Array<{ id: string; event_type: string }>;

  assert.equal(bookingRows.length, 1);
  assert.equal(bookingRows[0]?.id, result.booking.id);
  assert.equal(bookingRows[0]?.flight_id, flight.id);
  assert.equal(bookingRows[0]?.owner_account_id, OWNER_ACTOR.accountId);
  assert.equal(bookingRows[0]?.status, "HELD");

  assert.equal(auditRows.length, 1);
  assert.equal(outboxRows.length, 1);
  assert.equal(outboxRows[0]?.event_type, "booking-held");

  const afterFlight = await flightRepository.findById(flight.id);
  assert.equal(afterFlight?.availableSeats, 0);
});

// Day 48A Step 5 checkpoint: the seat link (flight_seats.booking_id) and the
// display copy (booking_passengers) agree, passenger by passenger, and the
// outbox carries the booking-held shape.
test("chosen seats for 3 passengers: each passenger's copy matches the seat HELD for the booking, one booking-held event", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ availableSeats: 6 });
  await flightRepository.create(flight);
  await keepFirstSeats(dataSource, flight.id, 6);

  const result = await createUseCase()(
    flight.id,
    {
      passengers: [
        { name: "Alice", seat: "1F" },
        { name: "Bob", seat: "1A" },
        { name: "Carol", seat: "1C" },
      ],
    },
    OWNER_ACTOR,
  );

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }
  assert.deepEqual(
    await dataSource.query(
      `SELECT p."position", p."name", p."seat_row" || p."seat_letter" AS copy,
              s."row" || s."letter" AS held, s."status"
       FROM "booking_passengers" p
       LEFT JOIN "flight_seats" s
         ON s."booking_id" = p."booking_id"
        AND (s."row", s."letter") = (p."seat_row", p."seat_letter")
       WHERE p."booking_id" = $1
       ORDER BY p."position"`,
      [result.booking.id],
    ),
    [
      { position: 1, name: "Alice", copy: "1F", held: "1F", status: "HELD" },
      { position: 2, name: "Bob", copy: "1A", held: "1A", status: "HELD" },
      { position: 3, name: "Carol", copy: "1C", held: "1C", status: "HELD" },
    ],
  );
  const [outbox] = (await dataSource.query(
    `SELECT "event_type", "payload" FROM "outbox"`,
  )) as Array<{ event_type: string; payload: { type: string; booking: unknown } }>;
  assert.equal(outbox?.event_type, "booking-held");
  assert.equal(outbox?.payload.type, "booking.held");
  assert.deepEqual(outbox?.payload.booking, {
    id: result.booking.id,
    reference: result.booking.reference,
    flightId: flight.id,
    createdAt: "2026-07-20T00:00:00.000Z",
    holdExpiresAt: "2026-07-20T00:15:00.000Z",
    passengers: ["Alice 1F", "Bob 1A", "Carol 1C"].map((entry) => {
      const [name, seat] = entry.split(" ");
      return { name, seat, fareClass: "ECONOMY", price: { amount: 1_500_000, currency: "VND" } };
    }),
    total: { amount: 4_500_000, currency: "VND" },
  });
  assert.equal((await flightRepository.findById(flight.id))?.availableSeats, 3);
});

// Day 48A Step 3 checkpoint: on Postgres a failed INSERT would abort the
// transaction and take the held seat with it. ON CONFLICT DO NOTHING keeps it
// usable: the redraw succeeds in the same transaction, the seat stays held.
test("a taken reference on the first draw: the booking is stored with the next one, its seat still HELD for it", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ availableSeats: 2 });
  await flightRepository.create(flight);
  await keepFirstSeats(dataSource, flight.id, 2);
  const existing = await createUseCase(() => "AAAAAA")(
    flight.id,
    { passengers: [{ name: "Alice" }] },
    OWNER_ACTOR,
  );
  assert.equal(existing.outcome, "created");

  const draws = ["AAAAAA", "BBBBBB"];
  const result = await createUseCase(() => draws.shift() ?? "ZZZZZZ")(
    flight.id,
    { passengers: [{ name: "Bob" }] },
    OWNER_ACTOR,
  );

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }
  assert.equal(result.booking.reference, "BBBBBB");
  assert.equal(draws.length, 0);
  assert.deepEqual(
    await dataSource.query(
      `SELECT b."reference", p."name", s."row" || s."letter" AS seat, s."status"
       FROM "bookings" b
       JOIN "booking_passengers" p ON p."booking_id" = b."id"
       JOIN "flight_seats" s ON s."booking_id" = b."id"
       ORDER BY b."reference"`,
    ),
    [
      { reference: "AAAAAA", name: "Alice", seat: "1A", status: "HELD" },
      { reference: "BBBBBB", name: "Bob", seat: "1B", status: "HELD" },
    ],
  );
  assert.equal((await dataSource.query(`SELECT id FROM audit_logs`)).length, 2);
  assert.equal((await dataSource.query(`SELECT id FROM outbox`)).length, 2);
});

test("not-enough-seats: no booking, audit, or outbox row is written, and the seat count is unchanged", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ availableSeats: 0 });
  await flightRepository.create(flight);
  await keepFirstSeats(dataSource, flight.id, 0);

  const createBooking = createUseCase();
  const result = await createBooking(flight.id, { passengers: [{ name: "Alice" }] }, OWNER_ACTOR);

  assert.equal(result.outcome, "not-enough-seats");

  const bookingRows = await dataSource.query(`SELECT id FROM bookings`);
  const auditRows = await dataSource.query(`SELECT id FROM audit_logs`);
  const outboxRows = await dataSource.query(`SELECT id FROM outbox`);

  assert.equal(bookingRows.length, 0);
  assert.equal(auditRows.length, 0);
  assert.equal(outboxRows.length, 0);

  const afterFlight = await flightRepository.findById(flight.id);
  assert.equal(afterFlight?.availableSeats, 0);
});

test("flight-not-found: resolves flight-not-found for an unknown flight id", async () => {
  const createBooking = createUseCase();

  const result = await createBooking(
    crypto.randomUUID(),
    { passengers: [{ name: "Alice" }] },
    OWNER_ACTOR,
  );

  assert.equal(result.outcome, "flight-not-found");
});
