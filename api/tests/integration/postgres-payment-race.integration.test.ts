import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createCancelBooking } from "../../src/bookings/cancel-booking.js";
import {
  createCreateBooking,
  HOLD_DURATION_MS,
} from "../../src/bookings/create-booking.js";
import { createExpireHolds } from "../../src/bookings/expire-holds.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresIdempotencyRepository } from "../../src/idempotency/postgres/postgres-idempotency-repository.js";
import { vnd } from "../../src/money/money.js";
import type { Logger } from "../../src/observability/logger.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import {
  createPayForBooking,
  type PayForBookingResult,
  type PaymentRequest,
} from "../../src/payments/pay-for-booking.js";
import type { PaymentGateway } from "../../src/payments/payment-gateway.js";
import { createPostgresPaymentRepository } from "../../src/payments/postgres/postgres-payment-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { resolveEntityManager } from "../../src/postgres/transaction-context.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { createFakePaymentGateway } from "../fakes/in-memory.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences, keepFirstSeats } from "./flight-references.js";

/**
 * Payment under real concurrency (Day 49B, Decision 14, ADR-009): separate
 * pg Pool connections running the real use cases, the gateway a scripted
 * fake whose `onCharge` holds a payment between phase 1 and phase 3. The
 * in-memory fakes cannot fail any of this — a claim waiting for an
 * uncommitted claim, the partial unique indexes, the booking row deciding
 * confirm against cancel and expiry, and SKIP LOCKED are Postgres semantics.
 */

const OWNER = { accountId: "11111111-1111-4111-8111-111111111111" };
const OWNER_SCOPE = { kind: "owner", accountId: OWNER.accountId } as const;
/** When every hold here is made; fixture flights depart in 2027. */
const HELD_AT = new Date("2026-07-20T00:00:00.000Z");
/** Their deadline: the first instant they are expired (BR-BOOK-10). */
const DEADLINE = new Date(HELD_AT.getTime() + HOLD_DURATION_MS);
/** When payments start: well inside the BR-PAY-07 margin. */
const PAY_AT = new Date(HELD_AT.getTime() + 60_000);
/** Two ECONOMY seats at the fixture fare. */
const TOTAL = vnd(3_000_000);
const ROUNDS = 20;

let dataSource: DataSource;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise a test opens by hand, and one the code under test signals. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** The real use case on Postgres; `clock.now` is read at each phase. */
function payForBookingWith(gateway: PaymentGateway, clock: { now: Date }) {
  return createPayForBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    paymentRepository: createPostgresPaymentRepository(dataSource),
    idempotencyRepository: createPostgresIdempotencyRepository(dataSource),
    paymentGateway: gateway,
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    logger: silentLogger,
    generatePaymentId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => clock.now,
  });
}

function cancelBookingAt(now: Date) {
  return createCancelBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => now,
  });
}

function expireHoldsAt(now: Date) {
  return createExpireHolds({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getCurrentTime: () => now,
    batchSize: 50,
    maxBatches: 20,
  });
}

/** A flight with two seats and a HELD booking of both, made at HELD_AT. */
async function heldBooking(): Promise<{ flightId: string; bookingId: string }> {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  await keepFirstSeats(dataSource, flight.id, 2);

  const result = await createCreateBooking({
    bookingRepository: createPostgresBookingRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateId: () => crypto.randomUUID(),
    generateReference: nextBookingReference,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => HELD_AT,
  })(flight.id, { passengers: [{ name: "Alice" }, { name: "Bob" }] }, OWNER);
  assert.equal(result.outcome, "created", JSON.stringify(result));
  return {
    flightId: flight.id,
    bookingId: result.outcome === "created" ? result.booking.id : "",
  };
}

/** The fingerprint covers the booking, as the route's path does. */
function paymentRequest(bookingId: string, idempotencyKey: string): PaymentRequest {
  return {
    idempotencyKey,
    fingerprint: `POST /api/bookings/${bookingId}/payments ${idempotencyKey}`,
    paymentMethodToken: "tok_success",
    amount: TOTAL,
  };
}

async function statusOf(bookingId: string): Promise<string | undefined> {
  const [row] = (await dataSource.query(
    `SELECT "status" FROM "bookings" WHERE "id" = $1`,
    [bookingId],
  )) as Array<{ status: string }>;
  return row?.status;
}

/** Statuses of the booking's payments, sorted. */
async function paymentsFor(bookingId: string): Promise<string[]> {
  const rows = (await dataSource.query(
    `SELECT "status" FROM "payments" WHERE "booking_id" = $1 ORDER BY "status"`,
    [bookingId],
  )) as Array<{ status: string }>;
  return rows.map((row) => row.status);
}

async function auditCount(action: string): Promise<number> {
  const [row] = (await dataSource.query(
    `SELECT count(*)::int AS "count" FROM "audit_logs" WHERE "action" = $1`,
    [action],
  )) as Array<{ count: number }>;
  return row?.count ?? 0;
}

async function outboxCount(eventType: string): Promise<number> {
  const [row] = (await dataSource.query(
    `SELECT count(*)::int AS "count" FROM "outbox" WHERE "event_type" = $1`,
    [eventType],
  )) as Array<{ count: number }>;
  return row?.count ?? 0;
}

/**
 * The invariant every test ends on: a seat is HELD exactly for a HELD
 * booking and BOOKED exactly for a CONFIRMED one; an EXPIRED or CANCELLED
 * booking owns no seat. Never CONFIRMED with its seats AVAILABLE.
 */
async function assertSeatsMatchBookings(flightId: string) {
  const [state] = (await dataSource.query(
    `SELECT
       (SELECT count(*)::int FROM "flight_seats" s
          JOIN "bookings" b ON b."id" = s."booking_id"
          WHERE s."flight_id" = $1
            AND NOT ((s."status" = 'HELD' AND b."status" = 'HELD')
                  OR (s."status" = 'BOOKED' AND b."status" = 'CONFIRMED'))) AS "mismatched",
       (SELECT count(*)::int FROM "flight_seats"
          WHERE "flight_id" = $1 AND "status" <> 'AVAILABLE') AS "takenSeats",
       (SELECT count(*)::int FROM "booking_passengers" p
          JOIN "bookings" b ON b."id" = p."booking_id"
          WHERE b."flight_id" = $1 AND b."status" IN ('HELD', 'CONFIRMED')) AS "livePassengers"`,
    [flightId],
  )) as Array<{ mismatched: number; takenSeats: number; livePassengers: number }>;
  assert.ok(state);
  assert.equal(state.mismatched, 0, "a seat's status disagrees with its booking's");
  assert.equal(state.takenSeats, state.livePassengers, "taken seats ≠ passengers of live bookings");
}

function statusOfResult(result: PayForBookingResult): string {
  return result.outcome === "answered"
    ? `${result.response.status}${result.replayed ? " replayed" : ""}`
    : result.outcome;
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  // CASCADE reaches payments and idempotency_keys through their foreign keys.
  await dataSource.query(
    'TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE',
  );
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

// ---- A: one key, many requests ----

const SAME_KEY_REQUESTS = 10;

test("Test A — 10 requests with one key at once: one charge, one 201, the rest in-progress or the same 201 replayed", async (t) => {
  const { flightId, bookingId } = await heldBooking();
  const gateway = createFakePaymentGateway({ onCharge: () => sleep(200) });
  const payForBooking = payForBookingWith(gateway, { now: PAY_AT });

  const results = await Promise.all(
    Array.from({ length: SAME_KEY_REQUESTS }, () =>
      payForBooking(bookingId, OWNER_SCOPE, OWNER, paymentRequest(bookingId, "key-a")),
    ),
  );

  const first = results.filter((result) => result.outcome === "answered" && !result.replayed);
  assert.equal(first.length, 1);
  const answer = first[0];
  assert.ok(answer?.outcome === "answered");
  assert.equal(answer.response.status, 201);
  for (const result of results) {
    if (result.outcome === "answered") {
      // A replay is the stored response itself.
      assert.deepEqual(result.response, answer.response);
    } else {
      assert.equal(result.outcome, "idempotency-key-in-progress");
    }
  }
  assert.equal(gateway.charges.length, 1);
  assert.equal(await statusOf(bookingId), "CONFIRMED");
  assert.deepEqual(await paymentsFor(bookingId), ["SUCCEEDED"]);
  const keys = (await dataSource.query(
    `SELECT "status", "payment_id" IS NOT NULL AS "linked" FROM "idempotency_keys"`,
  )) as Array<{ status: string; linked: boolean }>;
  assert.deepEqual(keys, [{ status: "COMPLETED", linked: true }]);
  await assertSeatsMatchBookings(flightId);
  t.diagnostic(results.map(statusOfResult).sort().join(", "));
});

// ---- B: many keys, one booking ----

const DIFFERENT_KEYS = 5;

test("Test B — 5 keys for one booking at once: at most one SUCCEEDED, every charge either succeeded or refunded, every request a clear answer", async (t) => {
  const tally = new Map<string, number>();

  for (let round = 0; round < ROUNDS / 2; round += 1) {
    const { flightId, bookingId } = await heldBooking();
    const gateway = createFakePaymentGateway({ onCharge: () => sleep(50) });
    const payForBooking = payForBookingWith(gateway, { now: PAY_AT });

    const results = await Promise.all(
      Array.from({ length: DIFFERENT_KEYS }, (_, index) =>
        payForBooking(bookingId, OWNER_SCOPE, OWNER, paymentRequest(bookingId, `key-b${round}-${index}`)),
      ),
    );

    for (const result of results) {
      const status = statusOfResult(result);
      assert.ok(
        ["201", "409", "payment-in-progress"].includes(status),
        `unexpected answer ${status}`,
      );
      tally.set(status, (tally.get(status) ?? 0) + 1);
    }
    const payments = await paymentsFor(bookingId);
    const succeeded = payments.filter((status) => status === "SUCCEEDED").length;
    assert.equal(succeeded, 1);
    assert.equal(gateway.charges.length, succeeded + gateway.refunds.length);
    assert.equal(payments.length, gateway.charges.length);
    assert.equal(await statusOf(bookingId), "CONFIRMED");
    await assertSeatsMatchBookings(flightId);
  }
  assert.equal(await outboxCount("booking-confirmed"), ROUNDS / 2);
  t.diagnostic([...tally].map(([status, count]) => `${status} ×${count}`).join(", "));
});

// ---- C / D: the booking ends while the gateway is charging ----

test("Test C — the hold lapses and the job expires it while the gateway charges: the job is not blocked, the charge is refunded", async () => {
  const { flightId, bookingId } = await heldBooking();
  const clock = { now: PAY_AT };
  const charging = gate();
  const release = gate();
  const gateway = createFakePaymentGateway({
    onCharge: async () => {
      charging.open();
      await release.opened;
    },
  });

  const paying = payForBookingWith(gateway, clock)(
    bookingId,
    OWNER_SCOPE,
    OWNER,
    paymentRequest(bookingId, "key-c"),
  );
  await charging.opened;

  // Phase 1 committed: no lock of the payment is in the job's way.
  const expired = await expireHoldsAt(DEADLINE)();
  assert.equal(expired.expired, 1);
  assert.equal(await statusOf(bookingId), "EXPIRED");

  clock.now = DEADLINE;
  release.open();
  const result = await paying;

  assert.equal(statusOfResult(result), "409");
  assert.equal(await statusOf(bookingId), "EXPIRED");
  assert.deepEqual(await paymentsFor(bookingId), ["REFUNDED"]);
  assert.equal(gateway.refunds.length, 1);
  assert.equal(await auditCount("BOOKING_CONFIRMED"), 0);
  assert.equal(await outboxCount("booking-confirmed"), 0);
  await assertSeatsMatchBookings(flightId);
});

test("Test D — the owner cancels while the gateway charges: the cancel is not blocked, the charge is refunded", async (t) => {
  const { flightId, bookingId } = await heldBooking();
  const charging = gate();
  const release = gate();
  const gateway = createFakePaymentGateway({
    onCharge: async () => {
      charging.open();
      await release.opened;
    },
  });

  const paying = payForBookingWith(gateway, { now: PAY_AT })(
    bookingId,
    OWNER_SCOPE,
    OWNER,
    paymentRequest(bookingId, "key-d"),
  );
  await charging.opened;

  const startedAt = performance.now();
  const cancelled = await cancelBookingAt(PAY_AT)(bookingId, OWNER_SCOPE, OWNER);
  const cancelMs = Math.round(performance.now() - startedAt);
  assert.equal(cancelled.outcome, "cancelled");

  release.open();
  const result = await paying;

  assert.equal(statusOfResult(result), "409");
  assert.equal(await statusOf(bookingId), "CANCELLED");
  assert.deepEqual(await paymentsFor(bookingId), ["REFUNDED"]);
  await assertSeatsMatchBookings(flightId);
  t.diagnostic(`cancel during the charge took ${cancelMs} ms`);
});

test("Test C (phase 3 at the deadline) — confirm 1 ms before it, expiry at it, together: exactly one ends the booking", async (t) => {
  const tally = { confirmed: 0, expired: 0 };

  for (let round = 0; round < ROUNDS; round += 1) {
    const { flightId, bookingId } = await heldBooking();
    const clock = { now: PAY_AT };
    let sweep: Promise<{ expired: number }> | undefined;
    const gateway = createFakePaymentGateway({
      // Phase 3 and the sweep start together, from inside the charge.
      onCharge: () => {
        clock.now = new Date(DEADLINE.getTime() - 1);
        sweep = expireHoldsAt(DEADLINE)();
      },
    });

    const result = await payForBookingWith(gateway, clock)(
      bookingId,
      OWNER_SCOPE,
      OWNER,
      paymentRequest(bookingId, `key-c${round}`),
    );
    assert.ok(sweep);
    const expired = await sweep;

    // The booking row lets one through; the other re-checks status = 'HELD'
    // against the committed row and matches nothing.
    if (statusOfResult(result) === "201") {
      assert.equal(expired.expired, 0);
      assert.equal(await statusOf(bookingId), "CONFIRMED");
      assert.deepEqual(await paymentsFor(bookingId), ["SUCCEEDED"]);
      tally.confirmed += 1;
    } else {
      assert.equal(statusOfResult(result), "409");
      assert.equal(expired.expired, 1);
      assert.equal(await statusOf(bookingId), "EXPIRED");
      assert.deepEqual(await paymentsFor(bookingId), ["REFUNDED"]);
      tally.expired += 1;
    }
    await assertSeatsMatchBookings(flightId);
  }
  assert.equal(
    (await auditCount("BOOKING_CONFIRMED")) + (await auditCount("BOOKING_EXPIRED")),
    ROUNDS,
  );
  t.diagnostic(`${ROUNDS} rounds: ${tally.confirmed} confirmed, ${tally.expired} expired and refunded`);
});

// ---- E: control — the gateway called inside the transaction ----

const CHARGE_MS = 1_000;

/**
 * Control for C and D — exists only here, never in src/. The design ADR-009
 * rejects: lock the booking, call the gateway, confirm, all in one
 * transaction. The sleep is the gateway call.
 */
async function payInsideOneTransaction(bookingId: string): Promise<void> {
  await createPostgresTransactionRunner(dataSource).run(async () => {
    await resolveEntityManager(dataSource).query(
      `SELECT 1 FROM "bookings" WHERE "id" = $1 FOR UPDATE`,
      [bookingId],
    );
    await sleep(CHARGE_MS);
    await createPostgresBookingRepository(dataSource).confirmHold(bookingId, OWNER_SCOPE, PAY_AT);
  });
}

test("Test E — control: with the charge inside the transaction, cancel waits for the whole charge and the job skips the booking", async (t) => {
  // Cancel against the control: blocked on the booking row for the charge.
  const blocked = await heldBooking();
  const controlPaying = payInsideOneTransaction(blocked.bookingId);
  await sleep(100);
  let startedAt = performance.now();
  await cancelBookingAt(PAY_AT)(blocked.bookingId, OWNER_SCOPE, OWNER);
  const controlCancelMs = Math.round(performance.now() - startedAt);
  await controlPaying;
  assert.ok(controlCancelMs >= CHARGE_MS - 200, `cancel took only ${controlCancelMs} ms`);

  // The job against the control: SKIP LOCKED passes the due booking over.
  const skipped = await heldBooking();
  const skippedPaying = payInsideOneTransaction(skipped.bookingId);
  await sleep(100);
  startedAt = performance.now();
  const sweep = await expireHoldsAt(DEADLINE)();
  const sweepMs = Math.round(performance.now() - startedAt);
  await skippedPaying;
  assert.equal(sweep.expired, 0, "the job expired a booking another transaction had locked");

  // Cancel against the real three phases, same charge time.
  const free = await heldBooking();
  const charging = gate();
  const gateway = createFakePaymentGateway({
    onCharge: async () => {
      charging.open();
      await sleep(CHARGE_MS);
    },
  });
  const paying = payForBookingWith(gateway, { now: PAY_AT })(
    free.bookingId,
    OWNER_SCOPE,
    OWNER,
    paymentRequest(free.bookingId, "key-e"),
  );
  await charging.opened;
  startedAt = performance.now();
  await cancelBookingAt(PAY_AT)(free.bookingId, OWNER_SCOPE, OWNER);
  const threePhaseCancelMs = Math.round(performance.now() - startedAt);
  await paying;
  assert.ok(threePhaseCancelMs < CHARGE_MS / 2, `cancel took ${threePhaseCancelMs} ms`);

  t.diagnostic(
    `charge ${CHARGE_MS} ms: cancel waited ${controlCancelMs} ms inside one transaction, ` +
      `${threePhaseCancelMs} ms with three phases; ` +
      `the job skipped the locked booking (${sweep.expired} expired, ${sweepMs} ms)`,
  );
});
