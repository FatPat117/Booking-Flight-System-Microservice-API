import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresPaymentRepository } from "../../src/payments/postgres/postgres-payment-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { makeBooking } from "../fixtures/bookings.js";
import { FIXTURE_FARES, FIXTURE_TWO_CLASS_AIRCRAFT_ID, makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import {
  assertGlobalInvariants,
  findInvariantViolations,
  type ProviderLedger,
} from "./invariants.js";

/**
 * The global invariants are what every race test from Day 50 on ends with
 * (invariants.ts). A check that has never failed is not known to work, so
 * each one is shown failing here on data broken on purpose, one kind at a
 * time, starting from a state where all of them hold.
 */

let dataSource: DataSource;

const NOW = new Date("2026-10-10T00:00:00.000Z");
const ADMIN = { kind: "admin" } as const;

type World = Readonly<{
  flightId: string;
  paid: { bookingId: string; paymentId: string };
  heldBookingId: string;
  ledger: ProviderLedger;
}>;

/**
 * A two-class flight (rows 1–2 BUSINESS) with a CONFIRMED booking on 3A + 3B
 * paid in full, and a HELD booking on 4A: every invariant holds.
 */
async function world(): Promise<World> {
  const flight = makeFlight({ availableSeats: 30, aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID });
  await createPostgresFlightRepository(dataSource).create(flight);
  const bookings = createPostgresBookingRepository(dataSource);
  const transactions = createPostgresTransactionRunner(dataSource);

  async function hold(codes: string[]): Promise<string> {
    const booking = {
      ...makeBooking({
        flightId: flight.id,
        passengers: codes.map((_, index) => ({ name: `P${index}`, seat: null, fareClass: null, price: null })),
      }),
      holdExpiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    };
    await transactions.run(async () => {
      const held = await bookings.holdSeats(flight.id, booking.id, {
        kind: "chosen",
        seats: codes.map((code) => ({ row: Number(code.slice(0, -1)), letter: code.slice(-1) })),
      }, NOW);
      assert.equal(held.outcome, "held");
      if (held.outcome !== "held") return;
      const passengers = booking.passengers.map((passenger, index) => ({
        ...passenger,
        seat: held.seats[index]?.seat ?? null,
        fareClass: held.seats[index]?.fareClass ?? null,
        price: held.seats[index]?.price ?? null,
      }));
      await bookings.create({ ...booking, passengers });
    });
    return booking.id;
  }

  const paidBookingId = await hold(["3A", "3B"]);
  assert.equal((await bookings.confirmHold(paidBookingId, ADMIN, NOW)).outcome, "confirmed");
  const payments = createPostgresPaymentRepository(dataSource);
  const paymentId = crypto.randomUUID();
  await payments.start({
    id: paymentId,
    bookingId: paidBookingId,
    accountId: crypto.randomUUID(),
    amount: { amount: 2 * FIXTURE_FARES.ECONOMY.amount, currency: "VND" },
    paymentMethodToken: "tok_success",
    nextAttemptAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  });
  await payments.markSucceeded(paymentId, "ch_1", NOW);

  return {
    flightId: flight.id,
    paid: { bookingId: paidBookingId, paymentId },
    heldBookingId: await hold(["4A"]),
    ledger: { charged: [paymentId], refunded: [] },
  };
}

async function expectViolation(ledger: ProviderLedger | undefined, pattern: RegExp) {
  const violations = await findInvariantViolations(dataSource, ledger);
  assert.ok(
    violations.some((violation) => pattern.test(violation)),
    `expected a violation matching ${pattern}, got ${JSON.stringify(violations)}`,
  );
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

test("the starting world breaks no invariant, money included", async () => {
  const { ledger } = await world();

  await assertGlobalInvariants(dataSource, ledger);
});

test("a BOOKED seat of a CANCELLED booking is caught (cancel that forgot the seats)", async () => {
  const { ledger, paid } = await world();
  await dataSource.query(`UPDATE "bookings" SET "status" = 'CANCELLED' WHERE "id" = $1`, [paid.bookingId]);
  await dataSource.query(`UPDATE "payments" SET "status" = 'REFUND_PENDING', "next_attempt_at" = now() WHERE "id" = $1`, [paid.paymentId]);

  await expectViolation(ledger, /^seat status agrees with its booking/);
  await expectViolation(ledger, /^a booking owns exactly one seat per live passenger/);
});

test("a HELD seat of a CONFIRMED booking is caught (confirm that forgot to book the seats)", async () => {
  const { flightId, paid } = await world();
  await dataSource.query(
    `UPDATE "flight_seats" SET "status" = 'HELD' WHERE "flight_id" = $1 AND "booking_id" = $2`,
    [flightId, paid.bookingId],
  );

  await expectViolation(undefined, /^seat status agrees with its booking/);
});

test("a display copy that names a seat the booking does not own is caught (a seat change that moved only the copy)", async () => {
  const { paid } = await world();
  await dataSource.query(
    `UPDATE "booking_passengers" SET "seat_letter" = 'F' WHERE "booking_id" = $1 AND "position" = 1`,
    [paid.bookingId],
  );

  await expectViolation(undefined, /^each live passenger owns the seat their copy names/);
});

test("a booking that kept an extra seat is caught (a seat change that took the new seat but kept the old)", async () => {
  const { flightId, paid } = await world();
  await dataSource.query(
    `UPDATE "flight_seats" SET "status" = 'BOOKED', "booking_id" = $2
     WHERE "flight_id" = $1 AND "row" = 5 AND "letter" = 'C'`,
    [flightId, paid.bookingId],
  );

  await expectViolation(undefined, /^a booking owns exactly one seat per live passenger/);
});

test("a passenger moved into another fare class is caught (a seat change across classes)", async () => {
  const { flightId, paid } = await world();
  // Move 3A → 1A (BUSINESS) consistently, so only the class check can fire.
  await dataSource.query(
    `UPDATE "flight_seats" SET "status" = 'AVAILABLE', "booking_id" = NULL
     WHERE "flight_id" = $1 AND "row" = 3 AND "letter" = 'A'`,
    [flightId],
  );
  await dataSource.query(
    `UPDATE "flight_seats" SET "status" = 'BOOKED', "booking_id" = $2
     WHERE "flight_id" = $1 AND "row" = 1 AND "letter" = 'A'`,
    [flightId, paid.bookingId],
  );
  await dataSource.query(
    `UPDATE "booking_passengers" SET "seat_row" = 1 WHERE "booking_id" = $1 AND "position" = 1`,
    [paid.bookingId],
  );

  const violations = await findInvariantViolations(dataSource);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  await expectViolation(undefined, /^a live passenger's seat is in their snapshot fare class/);
});

test("a cancelled paid booking whose payment stayed SUCCEEDED is caught (the Day 50 hole)", async () => {
  const { paid, ledger } = await world();
  await dataSource.query(
    `UPDATE "flight_seats" SET "status" = 'AVAILABLE', "booking_id" = NULL WHERE "booking_id" = $1`,
    [paid.bookingId],
  );
  await dataSource.query(`UPDATE "bookings" SET "status" = 'CANCELLED' WHERE "id" = $1`, [paid.bookingId]);

  await expectViolation(ledger, /^a SUCCEEDED payment belongs to a CONFIRMED booking/);
  await expectViolation(ledger, /^a cancelled booking's charged payment is on its way back/);
});

test("money: a second charge, a refund never charged, and a charge the database does not know are each caught", async () => {
  const { paid } = await world();

  await expectViolation({ charged: [paid.paymentId, paid.paymentId], refunded: [] }, /charged twice/);
  await expectViolation({ charged: [paid.paymentId], refunded: ["nope"] }, /refund of a payment never charged/);
  await expectViolation({ charged: [paid.paymentId, "ghost"], refunded: [] }, /charged an unknown payment/);
});

test("money: a paid booking the provider never charged, or refunded behind its back, does not add up", async () => {
  const { paid } = await world();

  await expectViolation({ charged: [], refunded: [] }, /kept 0 VND, but the paid CONFIRMED bookings total 3000000 VND/);
  await expectViolation(
    { charged: [paid.paymentId], refunded: [paid.paymentId] },
    /kept 0 VND, but the paid CONFIRMED bookings total 3000000 VND/,
  );
});

test("money: a cancelled booking still REFUND_PENDING is owed back, not kept — the books balance", async () => {
  const { paid, ledger } = await world();
  await dataSource.query(
    `UPDATE "flight_seats" SET "status" = 'AVAILABLE', "booking_id" = NULL WHERE "booking_id" = $1`,
    [paid.bookingId],
  );
  await dataSource.query(`UPDATE "bookings" SET "status" = 'CANCELLED' WHERE "id" = $1`, [paid.bookingId]);
  await dataSource.query(
    `UPDATE "payments" SET "status" = 'REFUND_PENDING', "next_attempt_at" = now() WHERE "id" = $1`,
    [paid.paymentId],
  );

  await assertGlobalInvariants(dataSource, ledger);
});
