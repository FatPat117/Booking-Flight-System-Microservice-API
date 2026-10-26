import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { vnd } from "../../src/money/money.js";
import type { NewPayment } from "../../src/payments/payment-repository.js";
import { createPostgresPaymentRepository } from "../../src/payments/postgres/postgres-payment-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { runPaymentRepositoryContract } from "../contracts/payment-repository.contract.js";
import { FIXTURE_ACCOUNT_A, makeBooking } from "../fixtures/bookings.js";
import { makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * The contract the in-memory fake runs in the unit tier
 * (tests/payment-repository.contract.test.ts), against real Postgres, plus
 * the one behavior a fake cannot have: a second start for a booking whose
 * first start is not committed yet waits for it.
 */

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  // CASCADE reaches payments and idempotency_keys through their foreign keys.
  await dataSource.query('TRUNCATE TABLE "bookings", "flights" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

async function seedBooking(): Promise<string> {
  const flight = makeFlight({ availableSeats: 1 });
  assert.deepEqual(
    await createPostgresFlightRepository(dataSource).create(flight),
    { outcome: "created" },
  );
  const booking = makeBooking({ flightId: flight.id });
  assert.deepEqual(
    await createPostgresBookingRepository(dataSource).create(booking),
    { outcome: "created" },
  );
  return booking.id;
}

runPaymentRepositoryContract("postgres", async () => ({
  repository: createPostgresPaymentRepository(dataSource),
  seedBooking,
}));

function newPayment(bookingId: string): NewPayment {
  return {
    id: crypto.randomUUID(),
    bookingId,
    accountId: FIXTURE_ACCOUNT_A,
    amount: vnd(3_000_000),
    createdAt: "2026-10-10T00:00:00.000Z",
  };
}

test("a concurrent start for the same booking waits for the first: payment-in-progress if it commits", async () => {
  const repository = createPostgresPaymentRepository(dataSource);
  const runner = createPostgresTransactionRunner(dataSource);
  const bookingId = await seedBooking();
  let releaseFirst!: () => void;
  const firstMayCommit = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = runner.run(async () => {
    const result = await repository.start(newPayment(bookingId));
    await firstMayCommit;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  let secondSettled = false;
  const second = repository.start(newPayment(bookingId)).finally(() => {
    secondSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondSettled, false, "the second start must wait for the first transaction");

  releaseFirst();

  assert.deepEqual(await first, { outcome: "started" });
  assert.deepEqual(await second, { outcome: "payment-in-progress" });
});

test("a concurrent start for the same booking starts if the first rolls back", async () => {
  const repository = createPostgresPaymentRepository(dataSource);
  const runner = createPostgresTransactionRunner(dataSource);
  const bookingId = await seedBooking();
  let releaseFirst!: () => void;
  const firstMayEnd = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = runner.run(async () => {
    await repository.start(newPayment(bookingId));
    await firstMayEnd;
    throw new Error("phase 1 failed");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = repository.start(newPayment(bookingId));
  releaseFirst();

  await assert.rejects(first, /phase 1 failed/);
  assert.deepEqual(await second, { outcome: "started" });
});
