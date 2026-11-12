import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createCancelBookingInTransaction } from "../../src/bookings/cancel-booking.js";
import {
  createCascadeFlightCancellations,
  FLIGHT_CANCELLATION_ACTOR,
} from "../../src/bookings/cascade-flight-cancellations.js";
import { createCreateBooking } from "../../src/bookings/create-booking.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createCancelFlight } from "../../src/flights/cancel-flight.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresIdempotencyRepository } from "../../src/idempotency/postgres/postgres-idempotency-repository.js";
import type { Logger } from "../../src/observability/logger.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { createPayForBooking } from "../../src/payments/pay-for-booking.js";
import { createPostgresPaymentRepository } from "../../src/payments/postgres/postgres-payment-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { resolveEntityManager } from "../../src/postgres/transaction-context.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { TransactionRunner } from "../../src/transactions/transaction-runner.js";
import { createFakePaymentGateway } from "../fakes/in-memory.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { FIXTURE_FARES, FIXTURE_OTHER_AIRCRAFT_ID, makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { assertCascadeComplete, assertGlobalInvariants } from "./invariants.js";

/**
 * Day 52 Step 5 — what option B buys, measured on one data set for both
 * options (Decision 18): a 120-seat flight with 100 paid one-seat bookings
 * and 20 free seats.
 *
 * A transaction's duration is the upper bound of how long it holds its
 * locks, so the numbers are per transaction. "Probe" holds measure what a
 * customer feels while the cancellation runs: one on the same flight (its
 * hold waits for the flight row, then is refused), one on another flight
 * (nothing in common).
 *
 * Timings depend on the machine and are reported with t.diagnostic, not
 * asserted; only correctness is asserted.
 */

let dataSource: DataSource;

const OWNER = { accountId: "11111111-1111-4111-8111-111111111111" };
const OWNER_SCOPE = { kind: "owner", accountId: OWNER.accountId } as const;
const ADMIN = { accountId: "aaaaaaaa-0000-4000-8000-000000000001" };
const NOW = new Date("2026-07-20T00:00:00.000Z");
const PAID_BOOKINGS = 100;
const silent: Logger = { info() {}, warn() {}, error() {} };

/** Records how long each transaction it runs takes. */
function timedRunner() {
  const real = createPostgresTransactionRunner(dataSource);
  const durations: number[] = [];
  const runner: TransactionRunner = {
    run: async (work) => {
      const start = performance.now();
      try {
        return await real.run(work);
      } finally {
        durations.push(performance.now() - start);
      }
    },
  };
  return { runner, durations };
}

function dependencies(transactionRunner: TransactionRunner = createPostgresTransactionRunner(dataSource)) {
  return {
    bookingRepository: createPostgresBookingRepository(dataSource),
    flightRepository: createPostgresFlightRepository(dataSource),
    paymentRepository: createPostgresPaymentRepository(dataSource),
    idempotencyRepository: createPostgresIdempotencyRepository(dataSource),
    paymentGateway: createFakePaymentGateway(),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner,
    logger: silent,
    generateId: () => crypto.randomUUID(),
    generateReference: nextBookingReference,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    generatePaymentId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => NOW,
    reconcileAfterMs: 40_000,
  };
}

/** The flight under test (100 paid bookings), and an unrelated flight. */
async function world(): Promise<{ flightId: string; otherFlightId: string }> {
  const flight = makeFlight();
  const other = makeFlight({ aircraftId: FIXTURE_OTHER_AIRCRAFT_ID });
  const flights = createPostgresFlightRepository(dataSource);
  await flights.create(flight);
  await flights.create(other);

  const deps = dependencies();
  const hold = createCreateBooking(deps);
  const pay = createPayForBooking(deps);
  for (let index = 0; index < PAID_BOOKINGS; index += 1) {
    const seat = `${Math.floor(index / 6) + 1}${"ABCDEF"[index % 6]}`;
    const held = await hold(flight.id, { passengers: [{ name: `P${index}`, seat }] }, OWNER);
    assert.equal(held.outcome, "created");
    if (held.outcome !== "created") continue;
    const paid = await pay(held.booking.id, OWNER_SCOPE, OWNER, {
      idempotencyKey: `key-${held.booking.id}`,
      fingerprint: `pay ${held.booking.id}`,
      paymentMethodToken: "tok_success",
      amount: FIXTURE_FARES.ECONOMY,
    });
    assert.equal(paid.outcome === "answered" && paid.response.status, 201);
  }
  return { flightId: flight.id, otherFlightId: other.id };
}

/** A one-seat auto hold and how long it took to answer. */
async function probe(flightId: string): Promise<{ outcome: string; ms: number }> {
  const start = performance.now();
  const result = await createCreateBooking(dependencies())(
    flightId,
    { fareClass: "ECONOMY", passengers: [{ name: "Probe" }] },
    OWNER,
  );
  return { outcome: result.outcome, ms: performance.now() - start };
}

function summary(durations: readonly number[]): string {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  return `${sorted.length} tx, total ${total.toFixed(1)} ms, median ${median.toFixed(2)} ms, max ${max.toFixed(2)} ms`;
}

async function cancelledAirline(flightId: string): Promise<number> {
  const [row] = (await dataSource.query(
    `SELECT count(*)::int AS "count" FROM "bookings"
     WHERE "flight_id" = $1 AND "status" = 'CANCELLED' AND "cancellation_reason" = 'AIRLINE'`,
    [flightId],
  )) as Array<{ count: number }>;
  return row?.count ?? 0;
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query(
    'TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox", "idempotency_keys" CASCADE',
  );
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

test("measure option B: the cancel is one short transaction, the cascade 100 short ones; a hold on the flight is refused at once", async (t) => {
  const { flightId, otherFlightId } = await world();

  const cancel = timedRunner();
  const cancelled = await createCancelFlight(dependencies(cancel.runner))(flightId, ADMIN);
  assert.equal(cancelled.outcome, "cancelled");

  const cascade = timedRunner();
  const deps = dependencies(cascade.runner);
  const run = createCascadeFlightCancellations({
    ...deps,
    cancelBookingInTransaction: createCancelBookingInTransaction(deps),
    maxPerRun: 500,
  });
  const started = performance.now();
  const cascading = run();
  // Probes while the cascade runs.
  const [sameFlight, otherFlight] = await Promise.all([probe(flightId), probe(otherFlightId)]);
  const result = await cascading;
  const cascadeMs = performance.now() - started;

  assert.equal(result.cancelled, PAID_BOOKINGS);
  assert.equal(result.refundsStarted, PAID_BOOKINGS);
  assert.equal(sameFlight.outcome, "sales-closed");
  assert.equal(otherFlight.outcome, "created");
  assert.equal(await cancelledAirline(flightId), PAID_BOOKINGS);
  await assertCascadeComplete(dataSource, NOW);
  await assertGlobalInvariants(dataSource);

  t.diagnostic(`B cancel-flight: ${summary(cancel.durations)}`);
  // The last run of the loop is the empty claim that ends it.
  t.diagnostic(`B cascade: ${summary(cascade.durations)}; whole run ${cascadeMs.toFixed(1)} ms`);
  t.diagnostic(`B probe same flight: ${sameFlight.outcome} in ${sameFlight.ms.toFixed(1)} ms`);
  t.diagnostic(`B probe other flight: ${otherFlight.outcome} in ${otherFlight.ms.toFixed(1)} ms`);
});

test("measure option A (test-only): everything in one transaction holds the flight for the whole run; a hold on the flight waits for all of it", async (t) => {
  const { flightId, otherFlightId } = await world();
  const deps = dependencies();
  const core = createCancelBookingInTransaction(deps);
  const bookingIds = (
    (await dataSource.query(
      `SELECT "id" FROM "bookings" WHERE "flight_id" = $1 AND "status" = 'CONFIRMED' ORDER BY "id"`,
      [flightId],
    )) as Array<{ id: string }>
  ).map((row) => row.id);

  let flightLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    flightLocked = resolve;
  });
  const started = performance.now();
  const optionA = createPostgresTransactionRunner(dataSource).run(async () => {
    await resolveEntityManager(dataSource).query(
      `UPDATE "flights" SET "status" = 'CANCELLED' WHERE "id" = $1`,
      [flightId],
    );
    flightLocked();
    for (const bookingId of bookingIds) {
      const outcome = await core({
        bookingId,
        scope: { kind: "admin" },
        reason: "AIRLINE",
        auditActor: FLIGHT_CANCELLATION_ACTOR,
        now: NOW,
      });
      assert.equal(outcome.outcome, "cancelled");
    }
  });
  await locked;
  // Probes while option A's single transaction runs.
  const [sameFlight, otherFlight] = await Promise.all([probe(flightId), probe(otherFlightId)]);
  await optionA;
  const transactionMs = performance.now() - started;

  assert.equal(sameFlight.outcome, "sales-closed");
  assert.equal(otherFlight.outcome, "created");
  assert.equal(await cancelledAirline(flightId), PAID_BOOKINGS);
  await assertGlobalInvariants(dataSource);

  t.diagnostic(`A one transaction: ${transactionMs.toFixed(1)} ms holding the flight row and ${PAID_BOOKINGS} bookings`);
  t.diagnostic(`A probe same flight: ${sameFlight.outcome} in ${sameFlight.ms.toFixed(1)} ms`);
  t.diagnostic(`A probe other flight: ${otherFlight.outcome} in ${otherFlight.ms.toFixed(1)} ms`);
});
