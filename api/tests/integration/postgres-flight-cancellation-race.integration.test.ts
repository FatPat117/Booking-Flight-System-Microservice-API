import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import type { BookingRepository } from "../../src/bookings/booking-repository.js";
import {
  createCancelBooking,
  createCancelBookingInTransaction,
  type CancelBookingInTransaction,
} from "../../src/bookings/cancel-booking.js";
import { createCascadeFlightCancellations } from "../../src/bookings/cascade-flight-cancellations.js";
import { createChangeSeat } from "../../src/bookings/change-seat.js";
import { createCreateBooking } from "../../src/bookings/create-booking.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createCancelFlight } from "../../src/flights/cancel-flight.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresIdempotencyRepository } from "../../src/idempotency/postgres/postgres-idempotency-repository.js";
import type { Logger } from "../../src/observability/logger.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { createPayForBooking, type PayForBookingResult } from "../../src/payments/pay-for-booking.js";
import { createPostgresPaymentRepository } from "../../src/payments/postgres/postgres-payment-repository.js";
import { createReconcilePayments } from "../../src/payments/reconcile-payments.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { isDeadlockDetected } from "../../src/postgres/postgres-errors.js";
import { resolveEntityManager } from "../../src/postgres/transaction-context.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import type { TransactionRunner } from "../../src/transactions/transaction-runner.js";
import { createFakePaymentGateway, type FakePaymentGateway } from "../fakes/in-memory.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { FIXTURE_FARES, makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { assertCascadeComplete, assertGlobalInvariants } from "./invariants.js";

/**
 * Day 52 — the flight cancellation cascade raced on Postgres (Decision 18,
 * option B). Every scenario ends with the global invariants (invariants.ts),
 * against the fake provider's ledger where money moved, and with the
 * cascade complete where it ran.
 *
 * The clock moves by 1 ms on every read, so audit entries are ordered and
 * the "no booking confirmed after its flight was cancelled" invariant can
 * tell before from after.
 *
 * A  — cancel among 20 concurrent holds: 0 deadlocks.
 * A' — option A (test-only) against a hold, forced: the Day 47 hypothesis.
 * B  — a payment at the gateway when the flight is cancelled.
 * C  — the owner and the cascade cancel the same booking.
 * D  — a seat change and the cascade on the same booking.
 * E  — two cascade instances over 100 bookings.
 * F  — the cascade stops after k bookings; the next run finishes.
 * G  — two admins cancel the same flight at once.
 */

let dataSource: DataSource;

const OWNER = { accountId: "11111111-1111-4111-8111-111111111111" };
const OWNER_SCOPE = { kind: "owner", accountId: OWNER.accountId } as const;
const ADMIN = { accountId: "aaaaaaaa-0000-4000-8000-000000000001" };
const NOW = new Date("2026-07-20T00:00:00.000Z");
const silent: Logger = { info() {}, warn() {}, error() {} };

let tick = 0;
function clock(): Date {
  tick += 1;
  return new Date(NOW.getTime() + tick);
}

/** A promise a test opens by hand, and one the code under test signals. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * A transaction runner whose first transaction stays open after its work
 * until `commit()`: its locks are held while the test starts the other
 * side. Later transactions run straight through.
 */
function pausingRunner() {
  const real = createPostgresTransactionRunner(dataSource);
  const reached = gate();
  const release = gate();
  let first = true;
  const runner: TransactionRunner = {
    run: (work) => {
      if (!first) {
        return real.run(work);
      }
      first = false;
      return real.run(async () => {
        const value = await work();
        reached.open();
        await release.opened;
        return value;
      });
    },
  };
  return { runner, workDone: reached.opened, commit: release.open };
}

function runtime(
  options: {
    gateway?: FakePaymentGateway;
    transactionRunner?: TransactionRunner;
    bookingRepository?: BookingRepository;
    wrapCancel?: (inner: CancelBookingInTransaction) => CancelBookingInTransaction;
  } = {},
) {
  const dependencies = {
    bookingRepository: options.bookingRepository ?? createPostgresBookingRepository(dataSource),
    flightRepository: createPostgresFlightRepository(dataSource),
    paymentRepository: createPostgresPaymentRepository(dataSource),
    idempotencyRepository: createPostgresIdempotencyRepository(dataSource),
    paymentGateway: options.gateway ?? createFakePaymentGateway(),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: options.transactionRunner ?? createPostgresTransactionRunner(dataSource),
    logger: silent,
    generateId: () => crypto.randomUUID(),
    generateReference: nextBookingReference,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    generatePaymentId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: clock,
    reconcileAfterMs: 40_000,
  };
  const pay = createPayForBooking(dependencies);
  const cancelBooking = createCancelBooking(dependencies);
  const changeSeat = createChangeSeat(dependencies);
  const core = createCancelBookingInTransaction(dependencies);

  return {
    hold: createCreateBooking(dependencies),
    pay: (bookingId: string) =>
      pay(bookingId, OWNER_SCOPE, OWNER, {
        idempotencyKey: `key-${bookingId}`,
        fingerprint: `pay ${bookingId}`,
        paymentMethodToken: "tok_success",
        amount: FIXTURE_FARES.ECONOMY,
      }),
    cancelBooking: (bookingId: string) => cancelBooking(bookingId, OWNER_SCOPE, OWNER),
    changeSeat: (bookingId: string, to: string) => {
      const position = parseSeatPosition(to);
      assert.ok(position, to);
      return changeSeat(bookingId, 1, position, OWNER_SCOPE, OWNER);
    },
    cancelFlight: (flightId: string) => createCancelFlight(dependencies)(flightId, ADMIN),
    cascade: createCascadeFlightCancellations({
      ...dependencies,
      cancelBookingInTransaction: options.wrapCancel?.(core) ?? core,
      maxPerRun: 500,
    }),
    reconcile: createReconcilePayments({
      ...dependencies,
      leaseMs: 40_000,
      batchSize: 20,
      maxBatches: 5,
    }),
  };
}

type Runtime = ReturnType<typeof runtime>;

/** An economy-only flight (120 seats, rows 1–20 ABCDEF), departing in 2027. */
async function createFlight(): Promise<string> {
  const flight = makeFlight();
  await createPostgresFlightRepository(dataSource).create(flight);
  return flight.id;
}

/** A one-passenger booking on `code`, HELD for 15 minutes. */
async function held(app: Runtime, flightId: string, code: string): Promise<string> {
  const result = await app.hold(flightId, { passengers: [{ name: `P${code}`, seat: code }] }, OWNER);
  assert.equal(result.outcome, "created", JSON.stringify(result));
  return result.outcome === "created" ? result.booking.id : "";
}

/** …and paid: CONFIRMED, its seat BOOKED, charged once by the provider. */
async function confirmed(app: Runtime, flightId: string, code: string): Promise<string> {
  const bookingId = await held(app, flightId, code);
  assert.equal(statusOfResult(await app.pay(bookingId)), 201);
  return bookingId;
}

function seatCodes(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${Math.floor(index / 6) + 1}${"ABCDEF"[index % 6]}`);
}

function statusOfResult(result: PayForBookingResult): number | string {
  return result.outcome === "answered" ? result.response.status : result.outcome;
}

async function bookingOf(bookingId: string) {
  const [row] = (await dataSource.query(
    `SELECT "status", "cancellation_reason" FROM "bookings" WHERE "id" = $1`,
    [bookingId],
  )) as Array<{ status: string; cancellation_reason: string | null }>;
  return row;
}

async function bookingsOnFlight(flightId: string): Promise<Array<{ status: string; reason: string | null }>> {
  return (await dataSource.query(
    `SELECT "status", "cancellation_reason" AS "reason" FROM "bookings" WHERE "flight_id" = $1`,
    [flightId],
  )) as Array<{ status: string; reason: string | null }>;
}

async function paymentsFor(bookingId: string): Promise<string[]> {
  const rows = (await dataSource.query(
    `SELECT "status" FROM "payments" WHERE "booking_id" = $1 ORDER BY "created_at"`,
    [bookingId],
  )) as Array<{ status: string }>;
  return rows.map((row) => row.status);
}

async function seatOf(flightId: string, code: string) {
  const position = parseSeatPosition(code);
  assert.ok(position, code);
  const [row] = (await dataSource.query(
    `SELECT "status", "booking_id" FROM "flight_seats"
     WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3`,
    [flightId, position.row, position.letter],
  )) as Array<{ status: string; booking_id: string | null }>;
  return row;
}

async function count(sql: string, parameters: unknown[] = []): Promise<number> {
  const [row] = (await dataSource.query(sql, parameters)) as Array<{ count: number }>;
  return row?.count ?? 0;
}

const auditCount = (action: string) =>
  count(`SELECT count(*)::int AS "count" FROM "audit_logs" WHERE "action" = $1`, [action]);

/** Resolves once at least `waiting` backends wait for a lock — no sleep-and-hope. */
async function untilWaiting(waiting: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if ((await count(`SELECT count(*)::int AS "count" FROM pg_locks WHERE NOT granted`)) >= waiting) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${waiting} backends queued on a lock within 5 s`);
}

/** The provider kept nothing: every charge was refunded exactly once. */
function assertNetZero(gateway: FakePaymentGateway, charges: number): void {
  assert.equal(gateway.ledger.charged.length, charges, "charges");
  assert.deepEqual([...gateway.ledger.refunded].sort(), [...gateway.ledger.charged].sort(), "all refunded");
}

/** The end state every scenario reaches once cascade and reconciliation ran. */
async function assertSettled(gateway?: FakePaymentGateway): Promise<void> {
  await assertCascadeComplete(dataSource, clock());
  await assertGlobalInvariants(dataSource, gateway?.ledger);
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

// ---- A: holds and a cancel at once ----

/**
 * Unforced, so which holds commit before the flight's UPDATE is up to
 * timing. Observed (Day 52): none was ever sales-closed — the cancel's
 * UPDATE waited until every hold had let go of the flight's share lock,
 * holds arriving later included. The other side, a hold queued behind the
 * cancel, is forced in "Test A (forced)".
 */
test("Test A — a flight cancelled among 20 concurrent holds: no deadlock, nothing thrown, every hold that got in is cascaded", async (t) => {
  const ROUNDS = 5;
  let totalCreated = 0;
  let totalSalesClosed = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const app = runtime();
    const flightId = await createFlight();
    // Half pick overlapping seat pairs (they wait for each other's seats),
    // half let the system pick (SKIP LOCKED); all share the flight row.
    const requests = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? { passengers: [{ name: "A", seat: `${(index % 5) + 1}A` }, { name: "B", seat: `${(index % 5) + 1}B` }] }
        : { fareClass: "ECONOMY", passengers: [{ name: "A" }, { name: "B" }] },
    );

    // Half the holds start with the cancel, half 1 ms after it was sent,
    // so some commit before the flight's UPDATE and some queue behind it.
    const later = (request: (typeof requests)[number]) =>
      new Promise<void>((resolve) => setTimeout(resolve, 1)).then(() => app.hold(flightId, request, OWNER));
    const settled = await Promise.allSettled([
      ...requests.slice(0, 10).map((request) => app.hold(flightId, request, OWNER)),
      ...requests.slice(10).map(later),
      app.cancelFlight(flightId),
    ]);

    const rejected = settled.filter((result) => result.status === "rejected");
    assert.deepEqual(rejected, [], "no statement failed — no 40P01, nothing thrown");
    const outcomes = settled
      .slice(0, 20)
      .map((result) => (result.status === "fulfilled" ? result.value.outcome : "rejected"));
    for (const outcome of outcomes) {
      assert.ok(["created", "sales-closed", "seats-unavailable"].includes(outcome), outcome);
    }
    const created = outcomes.filter((outcome) => outcome === "created").length;
    totalCreated += created;
    totalSalesClosed += outcomes.filter((outcome) => outcome === "sales-closed").length;

    await app.cascade();

    const bookings = await bookingsOnFlight(flightId);
    assert.equal(bookings.length, created);
    assert.ok(bookings.every((booking) => booking.status === "CANCELLED" && booking.reason === "AIRLINE"));
    await assertSettled();
    t.diagnostic(
      `round ${round + 1}: created ${created}, sales-closed ${outcomes.filter((o) => o === "sales-closed").length}, ` +
        `seats-unavailable ${outcomes.filter((o) => o === "seats-unavailable").length}`,
    );
  }
  t.diagnostic(`all rounds: created ${totalCreated}, sales-closed ${totalSalesClosed}`);
  assert.ok(totalCreated > 0, "holds got in, so the cascade had work");
});

test("Test A (queue) — a hold arriving while the cancel waits behind another hold's share lock gets in ahead of the cancel", async () => {
  const flightId = await createFlight();
  const first = pausingRunner();
  const firstHold = runtime({ transactionRunner: first.runner }).hold(
    flightId,
    { passengers: [{ name: "P", seat: "12A" }] },
    OWNER,
  );
  await first.workDone;

  const cancelling = runtime().cancelFlight(flightId);
  await untilWaiting(1);

  // FOR SHARE is compatible with the share lock already granted, so it is
  // granted at once — the cancel's queued UPDATE does not stop it.
  const secondHold = await runtime().hold(flightId, { passengers: [{ name: "Q", seat: "14C" }] }, OWNER);
  assert.equal(secondHold.outcome, "created");

  first.commit();
  assert.equal((await firstHold).outcome, "created");
  const cancelled = await cancelling;
  assert.equal(cancelled.outcome, "cancelled");
  assert.ok(cancelled.outcome === "cancelled");
  assert.equal(cancelled.remainingBookings, 2);
  await runtime().cascade();
  await assertSettled();
});

// ---- A': the Day 47 deadlock hypothesis ----

/**
 * Option A, test-only: one transaction that cancels the flight and then
 * locks every seat of it in (row, letter) order — the shape of "cancel
 * everything in the admin's transaction". It stops between the two, holding
 * the flight row, until `proceed` opens; `flightLocked` says it got there.
 */
function optionACancel(flightId: string) {
  const flightLocked = gate();
  const proceed = gate();
  const done = createPostgresTransactionRunner(dataSource).run(async () => {
    const manager = resolveEntityManager(dataSource);
    await manager.query(`UPDATE "flights" SET "status" = 'CANCELLED' WHERE "id" = $1`, [flightId]);
    flightLocked.open();
    await proceed.opened;
    await manager.query(
      `SELECT 1 FROM "flight_seats" WHERE "flight_id" = $1
       ORDER BY "row", "letter" FOR UPDATE`,
      [flightId],
    );
  });
  return { done, flightLocked: flightLocked.opened, proceed: proceed.open };
}

test("Test A' (control) — option A against a chosen-seat hold, forced: flight first then seats meets seats then flight", async (t) => {
  // Each deadlock costs deadlock_timeout (1 s) before Postgres breaks it.
  const ROUNDS = 3;
  let deadlocks = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight();
    const optionA = optionACancel(flightId);
    await optionA.flightLocked;

    // The hold locks 12A, then waits for the flight's share lock…
    const holding = runtime().hold(flightId, { passengers: [{ name: "P", seat: "12A" }] }, OWNER);
    await untilWaiting(1);
    // …while option A goes on to lock the flight's seats, 12A among them.
    optionA.proceed();

    const settled = await Promise.allSettled([optionA.done, holding]);
    for (const result of settled) {
      if (result.status === "rejected") {
        assert.ok(isDeadlockDetected(result.reason), String(result.reason));
        deadlocks += 1;
      }
    }
  }
  t.diagnostic(`${ROUNDS} rounds: ${deadlocks} deadlocks`);
  assert.equal(deadlocks, ROUNDS, "every round should deadlock");
});

test("Test A (forced) — the real cancel in the same interleaving: the hold queues on the flight and is sales-closed, 0 deadlocks", async (t) => {
  const ROUNDS = 3;
  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight();
    const pausing = pausingRunner();
    const cancelling = runtime({ transactionRunner: pausing.runner }).cancelFlight(flightId);
    await pausing.workDone;

    const holding = runtime().hold(flightId, { passengers: [{ name: "P", seat: "12A" }] }, OWNER);
    await untilWaiting(1);
    pausing.commit();

    assert.equal((await cancelling).outcome, "cancelled");
    assert.equal((await holding).outcome, "sales-closed");
    assert.equal((await seatOf(flightId, "12A"))?.status, "AVAILABLE");
  }
  t.diagnostic(`${ROUNDS} rounds: 0 deadlocks`);
  await assertSettled();
});

// ---- B: a payment at the gateway when the flight is cancelled ----

/**
 * A payment for a fresh HELD booking, stopped inside the gateway's charge
 * (phase 2: nothing locked) until the returned `release` is called.
 */
async function payingAtTheGateway() {
  const charging = gate();
  const proceed = gate();
  const gateway = createFakePaymentGateway({
    onCharge: async () => {
      charging.open();
      await proceed.opened;
    },
  });
  const app = runtime({ gateway });
  const flightId = await createFlight();
  const bookingId = await held(app, flightId, "12A");
  const paying = app.pay(bookingId);
  await charging.opened;
  return {
    flightId,
    bookingId,
    gateway,
    release: () => {
      proceed.open();
      return paying;
    },
  };
}

test("Test B1 — flight cancelled and cascaded while the gateway charges: phase 3 finds the booking cancelled, the charge is refunded", async () => {
  const { flightId, bookingId, gateway, release } = await payingAtTheGateway();
  const app = runtime({ gateway });

  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");
  assert.deepEqual(await app.cascade(), { cancelled: 1, refundsStarted: 0, exhausted: false });
  // Still PROCESSING: the cascade moves only SUCCEEDED payments.
  assert.deepEqual(await paymentsFor(bookingId), ["PROCESSING"]);

  assert.equal(statusOfResult(await release()), 409);
  assert.deepEqual(await paymentsFor(bookingId), ["REFUND_PENDING"]);
  assert.equal((await app.reconcile()).refunded, 1);

  assert.deepEqual(await bookingOf(bookingId), { status: "CANCELLED", cancellation_reason: "AIRLINE" });
  assert.deepEqual(await paymentsFor(bookingId), ["REFUNDED"]);
  assert.equal(await auditCount("BOOKING_CONFIRMED"), 0);
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
});

test("Test B2 — flight cancelled while the gateway charges, cascade not yet run: phase 3 refuses the cancelled flight, then the cascade ends the hold", async () => {
  const { flightId, bookingId, gateway, release } = await payingAtTheGateway();
  const app = runtime({ gateway });

  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");
  // Still HELD with a valid hold: only the flight check stops the confirm.
  assert.equal((await bookingOf(bookingId))?.status, "HELD");

  assert.equal(statusOfResult(await release()), 409);
  assert.equal((await bookingOf(bookingId))?.status, "HELD");
  assert.deepEqual(await paymentsFor(bookingId), ["REFUND_PENDING"]);

  assert.deepEqual(await app.cascade(), { cancelled: 1, refundsStarted: 0, exhausted: false });
  assert.equal((await app.reconcile()).refunded, 1);

  assert.deepEqual(await bookingOf(bookingId), { status: "CANCELLED", cancellation_reason: "AIRLINE" });
  assert.deepEqual(await paymentsFor(bookingId), ["REFUNDED"]);
  assert.equal(await auditCount("BOOKING_CONFIRMED"), 0);
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
});

test("Test B3 — phase 3 queued behind the flight cancel's uncommitted UPDATE re-reads the row after commit and refuses", async () => {
  const { flightId, bookingId, gateway, release } = await payingAtTheGateway();
  const pausing = pausingRunner();
  const cancelling = runtime({ gateway, transactionRunner: pausing.runner }).cancelFlight(flightId);
  await pausing.workDone;

  const confirming = release();
  await untilWaiting(1);
  pausing.commit();

  assert.equal((await cancelling).outcome, "cancelled");
  assert.equal(statusOfResult(await confirming), 409);
  assert.equal((await bookingOf(bookingId))?.status, "HELD");
  assert.deepEqual(await paymentsFor(bookingId), ["REFUND_PENDING"]);

  const app = runtime({ gateway });
  await app.cascade();
  await app.reconcile();
  assert.deepEqual(await bookingOf(bookingId), { status: "CANCELLED", cancellation_reason: "AIRLINE" });
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
});

test("Test B4 — phase 3 first: its flight share lock makes the cancel wait; the booking was confirmed before the cancel, so the cascade cancels and refunds it", async () => {
  const gateway = createFakePaymentGateway();
  const flightId = await createFlight();
  const bookingId = await held(runtime({ gateway }), flightId, "12A");

  // Phase 3's transaction stays open right after confirmHold.
  const confirmedInside = gate();
  const commitConfirm = gate();
  const repository = createPostgresBookingRepository(dataSource);
  const pausingRepository: BookingRepository = {
    ...repository,
    async confirmHold(...args) {
      const result = await repository.confirmHold(...args);
      confirmedInside.open();
      await commitConfirm.opened;
      return result;
    },
  };
  const paying = runtime({ gateway, bookingRepository: pausingRepository }).pay(bookingId);
  await confirmedInside.opened;

  const app = runtime({ gateway });
  const cancelling = app.cancelFlight(flightId);
  await untilWaiting(1);
  commitConfirm.open();

  assert.equal(statusOfResult(await paying), 201);
  const cancelled = await cancelling;
  assert.equal(cancelled.outcome, "cancelled");
  assert.ok(cancelled.outcome === "cancelled");
  assert.equal(cancelled.remainingBookings, 1);

  assert.deepEqual(await app.cascade(), { cancelled: 1, refundsStarted: 1, exhausted: false });
  assert.equal((await app.reconcile()).refunded, 1);
  assert.deepEqual(await bookingOf(bookingId), { status: "CANCELLED", cancellation_reason: "AIRLINE" });
  assert.deepEqual(await paymentsFor(bookingId), ["REFUNDED"]);
  // Confirmed, then cancelled — in that order, which the invariant checks.
  assert.equal(await auditCount("BOOKING_CONFIRMED"), 1);
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
});

test("Test B' (control) — the Day 49B confirm statement, without the flight check (test-only), confirms a booking on a cancelled flight", async () => {
  const app = runtime();
  const flightId = await createFlight();
  const bookingId = await held(app, flightId, "12A");
  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");

  const rows = (await dataSource.query(
    `WITH confirmed AS (
       UPDATE "bookings" SET "status" = 'CONFIRMED'
       WHERE "id" = $1 AND "status" = 'HELD' AND "hold_expires_at" > $2
       RETURNING "id"
     )
     SELECT "id" FROM confirmed`,
    [bookingId, NOW],
  )) as unknown[];

  assert.equal(rows.length, 1, "without the flight check the confirm wins on a cancelled flight");
  assert.equal((await bookingOf(bookingId))?.status, "CONFIRMED");
});

// ---- C: the owner and the cascade cancel the same booking ----

test("Test C1 — the owner's cancel holds the booking: the cascade skips it without waiting, and the owner's reason stands", async () => {
  const gateway = createFakePaymentGateway();
  const app = runtime({ gateway });
  const flightId = await createFlight();
  const bookingId = await confirmed(app, flightId, "12A");
  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");

  const pausing = pausingRunner();
  const owner = runtime({ gateway, transactionRunner: pausing.runner }).cancelBooking(bookingId);
  await pausing.workDone;

  // SKIP LOCKED: the cascade does not queue behind the owner.
  assert.deepEqual(await app.cascade(), { cancelled: 0, refundsStarted: 0, exhausted: false });
  pausing.commit();
  assert.equal((await owner).outcome, "cancelled");
  assert.deepEqual(await app.cascade(), { cancelled: 0, refundsStarted: 0, exhausted: false });

  assert.equal((await app.reconcile()).refunded, 1);
  assert.deepEqual(await bookingOf(bookingId), { status: "CANCELLED", cancellation_reason: "CUSTOMER" });
  assert.equal(await auditCount("BOOKING_CANCELLED"), 1);
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
});

test("Test C2 — the cascade holds the booking: the owner's cancel waits, then answers already-cancelled, and the airline's reason stands", async () => {
  const gateway = createFakePaymentGateway();
  const app = runtime({ gateway });
  const flightId = await createFlight();
  const bookingId = await confirmed(app, flightId, "12A");
  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");

  const pausing = pausingRunner();
  const cascading = runtime({ gateway, transactionRunner: pausing.runner }).cascade();
  await pausing.workDone;

  const owner = app.cancelBooking(bookingId);
  await untilWaiting(1);
  pausing.commit();

  assert.equal((await cascading).cancelled, 1);
  assert.deepEqual(await owner, { outcome: "already-cancelled" });
  assert.equal((await app.reconcile()).refunded, 1);
  assert.deepEqual(await bookingOf(bookingId), { status: "CANCELLED", cancellation_reason: "AIRLINE" });
  assert.equal(await auditCount("BOOKING_CANCELLED"), 1);
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
});

test("Test C3 — the owner and the cascade at the same moment, unforced: exactly one cancellation, one refund, the winner's reason", async (t) => {
  const gateway = createFakePaymentGateway();
  const app = runtime({ gateway });
  const flightId = await createFlight();
  const bookingId = await confirmed(app, flightId, "12A");
  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");

  const [owner, cascade] = await Promise.all([app.cancelBooking(bookingId), app.cascade()]);

  const ownerWon = owner.outcome === "cancelled";
  // Either the owner won, or the cascade cancelled it (and the owner either
  // queued and saw it cancelled, or was skipped past by SKIP LOCKED first).
  assert.equal(cascade.cancelled, ownerWon ? 0 : 1);
  assert.equal(
    (await bookingOf(bookingId))?.cancellation_reason,
    ownerWon ? "CUSTOMER" : "AIRLINE",
  );
  assert.equal(await auditCount("BOOKING_CANCELLED"), 1);
  await app.cascade();
  assert.equal((await app.reconcile()).refunded, 1);
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
  t.diagnostic(`winner: ${ownerWon ? "owner" : "cascade"}`);
});

// ---- D: a seat change and the cascade on the same booking ----

test("Test D1 — a seat change holding its locks makes the cancel wait; the cascade then releases the new seat, not the old one", async () => {
  const gateway = createFakePaymentGateway();
  const app = runtime({ gateway });
  const flightId = await createFlight();
  const bookingId = await confirmed(app, flightId, "12A");

  const pausing = pausingRunner();
  const changing = runtime({ gateway, transactionRunner: pausing.runner }).changeSeat(bookingId, "14C");
  await pausing.workDone;

  const cancelling = app.cancelFlight(flightId);
  await untilWaiting(1);
  pausing.commit();

  assert.equal((await changing).outcome, "changed");
  assert.equal((await cancelling).outcome, "cancelled");
  assert.equal((await app.cascade()).cancelled, 1);
  await app.reconcile();

  assert.equal((await seatOf(flightId, "12A"))?.status, "AVAILABLE");
  assert.deepEqual(await seatOf(flightId, "14C"), { status: "AVAILABLE", booking_id: null });
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
});

test("Test D2 — a seat change queued behind the cascade's booking lock finds the booking cancelled (not-changeable) and moves nothing", async () => {
  const gateway = createFakePaymentGateway();
  const app = runtime({ gateway });
  const flightId = await createFlight();
  const bookingId = await confirmed(app, flightId, "12A");
  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");

  const pausing = pausingRunner();
  const cascading = runtime({ gateway, transactionRunner: pausing.runner }).cascade();
  await pausing.workDone;

  const changing = app.changeSeat(bookingId, "14C");
  await untilWaiting(1);
  pausing.commit();

  assert.equal((await cascading).cancelled, 1);
  // It waited for the booking, then re-read it: CANCELLED is checked before
  // the sales window, so the answer is about the booking, not the flight.
  assert.equal((await changing).outcome, "not-changeable");
  await app.reconcile();
  assert.deepEqual(await seatOf(flightId, "14C"), { status: "AVAILABLE", booking_id: null });
  assertNetZero(gateway, 1);
  await assertSettled(gateway);
});

// ---- E: two cascade instances ----

test("Test E — two cascade instances over 100 bookings (20 paid): each booking cancelled once, one audit entry and one event each, 20 refunds", async () => {
  const gateway = createFakePaymentGateway();
  const app = runtime({ gateway });
  const flightId = await createFlight();
  const codes = seatCodes(100);
  for (const [index, code] of codes.entries()) {
    if (index < 20) {
      await confirmed(app, flightId, code);
    } else {
      await held(app, flightId, code);
    }
  }
  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");

  const [first, second] = await Promise.all([runtime({ gateway }).cascade(), runtime({ gateway }).cascade()]);

  assert.equal(first.cancelled + second.cancelled, 100);
  assert.equal(first.refundsStarted + second.refundsStarted, 20);
  assert.ok(first.cancelled > 0 && second.cancelled > 0, `both worked: ${first.cancelled} + ${second.cancelled}`);
  assert.equal(
    await count(
      `SELECT count(*)::int AS "count" FROM (
         SELECT "target_id" FROM "audit_logs" WHERE "action" = 'BOOKING_CANCELLED'
         GROUP BY "target_id" HAVING count(*) <> 1) twice`,
    ),
    0,
  );
  assert.equal(await auditCount("BOOKING_CANCELLED"), 100);
  assert.equal(
    await count(`SELECT count(*)::int AS "count" FROM "outbox" WHERE "event_type" = 'booking-cancelled'`),
    100,
  );
  assert.equal((await app.reconcile()).refunded, 20);
  assertNetZero(gateway, 20);
  await assertSettled(gateway);
});

// ---- F: the job stops halfway ----

test("Test F — the cascade stops after 4 of 10 bookings (fault injected); the next run cancels the other 6, none twice", async () => {
  const gateway = createFakePaymentGateway();
  const app = runtime({ gateway });
  const flightId = await createFlight();
  for (const [index, code] of seatCodes(10).entries()) {
    if (index % 3 === 0) {
      await confirmed(app, flightId, code);
    } else {
      await held(app, flightId, code);
    }
  }
  assert.equal((await app.cancelFlight(flightId)).outcome, "cancelled");

  let calls = 0;
  const crashing = runtime({
    gateway,
    wrapCancel: (core) => async (input) => {
      calls += 1;
      const result = await core(input);
      if (calls === 5) {
        // Inside the 5th booking's transaction, after its writes: rolled back.
        throw new Error("process stopped");
      }
      return result;
    },
  });
  await assert.rejects(crashing.cascade(), /process stopped/);
  assert.equal(await auditCount("BOOKING_CANCELLED"), 4);
  // Claimed by id, so which paid bookings fell among the first 4 varies.
  const refundsBeforeCrash = await count(
    `SELECT count(*)::int AS "count" FROM "payments" WHERE "status" = 'REFUND_PENDING'`,
  );

  assert.deepEqual(await app.cascade(), {
    cancelled: 6,
    refundsStarted: 4 - refundsBeforeCrash,
    exhausted: false,
  });
  assert.equal(await auditCount("BOOKING_CANCELLED"), 10);
  assert.equal((await app.reconcile()).refunded, 4);
  assertNetZero(gateway, 4);
  await assertSettled(gateway);
});

// ---- G: two admins cancel the same flight ----

test("Test G — two admins cancel the same flight at once: one cancels, the other gets the same success; one audit entry", async () => {
  const app = runtime();
  const flightId = await createFlight();
  await held(app, flightId, "12A");

  const results = await Promise.all([app.cancelFlight(flightId), runtime().cancelFlight(flightId)]);

  assert.deepEqual(results.map((result) => result.outcome).sort(), ["already-cancelled", "cancelled"]);
  for (const result of results) {
    assert.ok(result.outcome === "cancelled" || result.outcome === "already-cancelled");
    assert.equal(result.remainingBookings, 1);
  }
  assert.equal(await auditCount("FLIGHT_CANCELLED"), 1);

  await app.cascade();
  const again = await app.cancelFlight(flightId);
  assert.equal(again.outcome, "already-cancelled");
  assert.ok(again.outcome === "already-cancelled");
  assert.equal(again.remainingBookings, 0);
  await assertSettled();
});
