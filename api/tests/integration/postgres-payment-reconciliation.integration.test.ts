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
import {
  createCleanupIdempotencyKeys,
  IDEMPOTENCY_KEY_RETENTION_MS,
} from "../../src/idempotency/cleanup-idempotency-keys.js";
import { createPostgresIdempotencyRepository } from "../../src/idempotency/postgres/postgres-idempotency-repository.js";
import { vnd } from "../../src/money/money.js";
import type { Logger, LogFields } from "../../src/observability/logger.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import {
  createPayForBooking,
  type PayForBookingResult,
  type PaymentRequest,
} from "../../src/payments/pay-for-booking.js";
import { createPostgresPaymentRepository } from "../../src/payments/postgres/postgres-payment-repository.js";
import { createReconcilePayments } from "../../src/payments/reconcile-payments.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { resolveEntityManager } from "../../src/postgres/transaction-context.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { createFakePaymentGateway, type FakePaymentGateway } from "../fakes/in-memory.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences, keepFirstSeats } from "./flight-references.js";

/**
 * Day 49C — payment failures, on Postgres (Decision 15, ADR-010).
 *
 * Fault injection at each place a payment can stop: after phase 1, during
 * the charge, after a charge whose answer was lost, after REFUND_PENDING,
 * and refunds that fail. Each test lets reconciliation finish, then checks
 * one global invariant (assertMoneyInvariants) against the fake gateway's
 * ledger — what the provider really did, not what the code heard.
 *
 * The race tests need Postgres: a live request and the job on one payment,
 * and two job instances on one backlog (SKIP LOCKED, the lease).
 */

const OWNER = { accountId: "11111111-1111-4111-8111-111111111111" };
const OWNER_SCOPE = { kind: "owner", accountId: OWNER.accountId } as const;
const HELD_AT = new Date("2026-07-20T00:00:00.000Z");
const DEADLINE = new Date(HELD_AT.getTime() + HOLD_DURATION_MS);
const PAY_AT = new Date(HELD_AT.getTime() + 60_000);
/** Gateway timeout + reconciliation margin: the age gate and the lease. */
const RECONCILE_AFTER_MS = 40_000;
const DUE_AT = new Date(PAY_AT.getTime() + RECONCILE_AFTER_MS);
const MINUTE_MS = 60_000;
const TOTAL = vnd(3_000_000);
const ABANDONED = 30;

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

function memoryLogger() {
  const entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const push = (level: string) => (message: string, fields?: LogFields) => {
    entries.push(fields === undefined ? { level, message } : { level, message, fields });
  };
  const logger: Logger = { info: push("info"), warn: push("warn"), error: push("error") };
  return { logger, entries };
}

/** The real use cases on Postgres, sharing one gateway and one clock. */
function runtime(gateway: FakePaymentGateway, clock: { now: Date }, logger: Logger) {
  const repositories = {
    bookingRepository: createPostgresBookingRepository(dataSource),
    paymentRepository: createPostgresPaymentRepository(dataSource),
    idempotencyRepository: createPostgresIdempotencyRepository(dataSource),
    paymentGateway: gateway,
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    logger,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => clock.now,
  };
  const payForBooking = createPayForBooking({
    ...repositories,
    generatePaymentId: () => crypto.randomUUID(),
    reconcileAfterMs: RECONCILE_AFTER_MS,
  });
  const reconcilerWith = (options: { leaseMs?: number; batchSize?: number } = {}) =>
    createReconcilePayments({
      ...repositories,
      leaseMs: options.leaseMs ?? RECONCILE_AFTER_MS,
      batchSize: options.batchSize ?? 20,
      maxBatches: 5,
    });

  return {
    pay: (bookingId: string, key = "key-1"): Promise<PayForBookingResult> =>
      payForBooking(bookingId, OWNER_SCOPE, OWNER, paymentRequest(bookingId, key)),
    reconcile: reconcilerWith(),
    reconcilerWith,
    expireHolds: createExpireHolds({
      ...repositories,
      batchSize: 50,
      maxBatches: 20,
    }),
    cancel: (bookingId: string) =>
      createCancelBooking(repositories)(bookingId, OWNER_SCOPE, OWNER),
    cleanupKeys: createCleanupIdempotencyKeys({
      ...repositories,
      batchSize: 500,
      maxBatches: 20,
    }),
  };
}

/** A flight with two seats and a HELD booking of both, made at HELD_AT. */
async function heldBooking(): Promise<string> {
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
  return result.outcome === "created" ? result.booking.id : "";
}

function paymentRequest(bookingId: string, idempotencyKey: string): PaymentRequest {
  return {
    idempotencyKey,
    fingerprint: `POST /api/bookings/${bookingId}/payments ${idempotencyKey}`,
    paymentMethodToken: "tok_success",
    amount: TOTAL,
  };
}

function statusOfResult(result: PayForBookingResult): string {
  return result.outcome === "answered"
    ? `${result.response.status}${result.replayed ? " replayed" : ""}`
    : result.outcome;
}

async function bookingStatus(bookingId: string): Promise<string | undefined> {
  const [row] = (await dataSource.query(`SELECT "status" FROM "bookings" WHERE "id" = $1`, [
    bookingId,
  ])) as Array<{ status: string }>;
  return row?.status;
}

async function paymentOf(bookingId: string) {
  const rows = (await dataSource.query(
    `SELECT "id", "status", "attempts", "next_attempt_at" AS "nextAttemptAt"
     FROM "payments" WHERE "booking_id" = $1`,
    [bookingId],
  )) as Array<{ id: string; status: string; attempts: number; nextAttemptAt: Date | null }>;
  assert.equal(rows.length, 1, `booking ${bookingId} has ${rows.length} payments`);
  return rows[0]!;
}

async function count(sql: string, parameters: unknown[] = []): Promise<number> {
  const [row] = (await dataSource.query(sql, parameters)) as Array<{ count: number }>;
  return row?.count ?? 0;
}

const FINAL_RESPONSE: Record<string, number> = {
  SUCCEEDED: 201,
  FAILED: 402,
  REFUNDED: 409,
  REFUND_FAILED: 409,
};

/**
 * Checked at the end of every test, once reconciliation has finished:
 * - money was taken for a payment exactly when it is SUCCEEDED with its
 *   booking CONFIRMED, or REFUNDED, or REFUND_FAILED (reported for a person);
 *   given back exactly when REFUNDED. No payment is left in flight.
 * - the provider charged and refunded each payment id at most once, and
 *   never one the database does not know.
 * - a booking is CONFIRMED exactly when it has a SUCCEEDED payment; seats
 *   are BOOKED exactly for CONFIRMED bookings, HELD for HELD ones.
 * - every key that started a payment (and was not cleaned up) is COMPLETED
 *   with the response its payment's final state means.
 */
async function assertMoneyInvariants(gateway: FakePaymentGateway) {
  const { charged, refunded } = gateway.ledger;
  assert.equal(new Set(charged).size, charged.length, "a payment id was charged twice");
  assert.equal(new Set(refunded).size, refunded.length, "a payment id was refunded twice");

  const payments = (await dataSource.query(
    `SELECT p."id", p."status", b."status" AS "bookingStatus",
            k."status" AS "keyStatus", k."response_status" AS "responseStatus"
     FROM "payments" p
     JOIN "bookings" b ON b."id" = p."booking_id"
     LEFT JOIN "idempotency_keys" k ON k."payment_id" = p."id"`,
  )) as Array<{
    id: string;
    status: string;
    bookingStatus: string;
    keyStatus: string | null;
    responseStatus: number | null;
  }>;

  for (const payment of payments) {
    const moneyTaken = charged.includes(payment.id);
    const moneyBack = refunded.includes(payment.id);
    const where = `payment ${payment.id} (${payment.status}, booking ${payment.bookingStatus})`;

    switch (payment.status) {
      case "SUCCEEDED":
        assert.ok(moneyTaken && !moneyBack && payment.bookingStatus === "CONFIRMED", where);
        break;
      case "FAILED":
        assert.ok(!moneyTaken, where);
        break;
      case "REFUNDED":
        assert.ok(moneyTaken && moneyBack && payment.bookingStatus !== "CONFIRMED", where);
        break;
      case "REFUND_FAILED":
        assert.ok(moneyTaken && !moneyBack && payment.bookingStatus !== "CONFIRMED", where);
        break;
      default:
        assert.fail(`${where} is still in flight`);
    }

    if (payment.keyStatus !== null) {
      assert.equal(payment.keyStatus, "COMPLETED", where);
      assert.equal(payment.responseStatus, FINAL_RESPONSE[payment.status], where);
    }
  }

  const known = new Set(payments.map(({ id }) => id));
  assert.ok(charged.every((id) => known.has(id)), "the provider charged an unknown payment");

  assert.equal(
    await count(
      `SELECT count(*)::int AS "count" FROM "bookings" b
       WHERE (b."status" = 'CONFIRMED') <> EXISTS (
         SELECT 1 FROM "payments" p WHERE p."booking_id" = b."id" AND p."status" = 'SUCCEEDED')`,
    ),
    0,
    "CONFIRMED disagrees with having a SUCCEEDED payment",
  );
  assert.equal(
    await count(
      `SELECT count(*)::int AS "count" FROM "flight_seats" s
       LEFT JOIN "bookings" b ON b."id" = s."booking_id"
       WHERE NOT ((s."status" = 'AVAILABLE' AND s."booking_id" IS NULL)
               OR (s."status" = 'HELD' AND b."status" = 'HELD')
               OR (s."status" = 'BOOKED' AND b."status" = 'CONFIRMED'))`,
    ),
    0,
    "a seat's status disagrees with its booking's",
  );
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  // CASCADE reaches payments and idempotency_keys through their foreign keys.
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

// ---- The four stopping points, and refunds that fail ----

test("Scenario 1 — the process stops after phase 1, before the gateway hears anything: the job charges and confirms", async () => {
  let crashed = true;
  const gateway = createFakePaymentGateway({
    onCharge: () => {
      if (crashed) {
        throw new Error("process stopped");
      }
    },
  });
  const clock = { now: PAY_AT };
  const app = runtime(gateway, clock, memoryLogger().logger);
  const bookingId = await heldBooking();

  await assert.rejects(app.pay(bookingId), /process stopped/);
  assert.deepEqual(gateway.ledger.charged, []);
  crashed = false;
  clock.now = DUE_AT;
  const run = await app.reconcile();

  assert.equal(run.settled, 1);
  assert.equal(await bookingStatus(bookingId), "CONFIRMED");
  assert.equal(statusOfResult(await app.pay(bookingId)), "201 replayed");
  await assertMoneyInvariants(gateway);
});

test("Scenario 2 — the charge times out before the provider received it: 202, then the job charges once and confirms", async () => {
  const gateway = createFakePaymentGateway();
  gateway.willCharge({ outcome: "unknown", reason: "timeout" });
  const clock = { now: PAY_AT };
  const app = runtime(gateway, clock, memoryLogger().logger);
  const bookingId = await heldBooking();

  assert.equal(statusOfResult(await app.pay(bookingId)), "processing");
  assert.equal(statusOfResult(await app.pay(bookingId)), "idempotency-key-in-progress");
  clock.now = DUE_AT;
  await app.reconcile();

  assert.equal(await bookingStatus(bookingId), "CONFIRMED");
  assert.equal(gateway.charges.length, 2);
  assert.equal(gateway.ledger.charged.length, 1);
  await assertMoneyInvariants(gateway);
});

test("Scenario 3 — the provider charged but the answer was lost, hold still valid: the job's second charge returns the first, and the booking is confirmed without a second charge", async () => {
  const gateway = createFakePaymentGateway();
  gateway.willCharge({ outcome: "lost-response" });
  const clock = { now: PAY_AT };
  const app = runtime(gateway, clock, memoryLogger().logger);
  const bookingId = await heldBooking();

  assert.equal(statusOfResult(await app.pay(bookingId)), "processing");
  const { id: paymentId } = await paymentOf(bookingId);
  assert.deepEqual(gateway.ledger.charged, [paymentId]);
  assert.equal((await paymentOf(bookingId)).status, "PROCESSING");
  clock.now = DUE_AT;
  await app.reconcile();

  assert.equal(await bookingStatus(bookingId), "CONFIRMED");
  assert.deepEqual(gateway.ledger.charged, [paymentId]);
  assert.equal(statusOfResult(await app.pay(bookingId)), "201 replayed");
  await assertMoneyInvariants(gateway);
});

test("Scenario 3b — the provider charged, the answer was lost, and the hold expired before reconciliation: the job leaves it for refund, then refunds it", async () => {
  const gateway = createFakePaymentGateway();
  gateway.willCharge({ outcome: "lost-response" });
  const clock = { now: PAY_AT };
  const app = runtime(gateway, clock, memoryLogger().logger);
  const bookingId = await heldBooking();
  await app.pay(bookingId);

  clock.now = DEADLINE;
  assert.equal((await app.expireHolds()).expired, 1);
  assert.equal((await app.reconcile()).settled, 1);
  assert.equal((await paymentOf(bookingId)).status, "REFUND_PENDING");
  assert.equal((await app.reconcile()).refunded, 1);

  assert.equal(await bookingStatus(bookingId), "EXPIRED");
  assert.equal((await paymentOf(bookingId)).status, "REFUNDED");
  assert.equal(statusOfResult(await app.pay(bookingId)), "409 replayed");
  await assertMoneyInvariants(gateway);
});

test("Scenario 4 — REFUND_PENDING committed, refund never made (the request no longer refunds): the job refunds it", async () => {
  const clock = { now: PAY_AT };
  const gateway = createFakePaymentGateway({
    onCharge: () => {
      clock.now = DEADLINE;
    },
  });
  const app = runtime(gateway, clock, memoryLogger().logger);
  const bookingId = await heldBooking();

  assert.equal(statusOfResult(await app.pay(bookingId)), "409");
  assert.equal((await paymentOf(bookingId)).status, "REFUND_PENDING");
  assert.deepEqual(gateway.refunds, []);
  assert.equal((await app.reconcile()).refunded, 1);

  assert.equal((await paymentOf(bookingId)).status, "REFUNDED");
  await assertMoneyInvariants(gateway);
});

test("Scenario 5 — a refund that fails twice is REFUNDED on the third attempt, 1 and 2 minutes apart", async () => {
  const clock = { now: PAY_AT };
  const gateway = createFakePaymentGateway({
    onCharge: () => {
      clock.now = DEADLINE;
    },
  });
  const transient = { outcome: "failed", reason: "provider_unavailable", retryable: true } as const;
  gateway.willRefund(transient, transient);
  const app = runtime(gateway, clock, memoryLogger().logger);
  const bookingId = await heldBooking();
  await app.pay(bookingId);

  for (const minutes of [0, 1, 3]) {
    clock.now = new Date(DEADLINE.getTime() + minutes * MINUTE_MS);
    await app.reconcile();
  }

  assert.equal((await paymentOf(bookingId)).status, "REFUNDED");
  assert.equal(gateway.refunds.length, 3);
  await assertMoneyInvariants(gateway);
});

test("Scenario 6 — a refund that cannot succeed is REFUND_FAILED, never retried, and logged as an error for a person", async () => {
  const clock = { now: PAY_AT };
  const gateway = createFakePaymentGateway({
    onCharge: () => {
      clock.now = DEADLINE;
    },
  });
  gateway.willRefund({ outcome: "failed", reason: "card_account_closed", retryable: false });
  const { logger, entries } = memoryLogger();
  const app = runtime(gateway, clock, logger);
  const bookingId = await heldBooking();
  await app.pay(bookingId);

  assert.equal((await app.reconcile()).refundFailed, 1);
  clock.now = new Date(DEADLINE.getTime() + 60 * MINUTE_MS);
  assert.equal((await app.reconcile()).refundFailed, 0);

  assert.equal((await paymentOf(bookingId)).status, "REFUND_FAILED");
  assert.equal(gateway.refunds.length, 1);
  assert.deepEqual(
    entries.filter(({ level }) => level === "error").map(({ message }) => message),
    ["payment_refund_needs_attention"],
  );
  assert.equal(
    await count(`SELECT count(*)::int AS "count" FROM "audit_logs" WHERE "action" = 'PAYMENT_REFUND_FAILED'`),
    1,
  );
  await assertMoneyInvariants(gateway);
});

// ---- Races ----

test("Race — a live request still charging and the job on the same payment: one of them confirms, once; the loser changes nothing, and the key answers 201", async () => {
  const charging = gate();
  const release = gate();
  let first = true;
  const gateway = createFakePaymentGateway({
    onCharge: async () => {
      if (first) {
        first = false;
        charging.open();
        await release.opened;
      }
    },
  });
  const clock = { now: PAY_AT };
  const app = runtime(gateway, clock, memoryLogger().logger);
  const bookingId = await heldBooking();

  const paying = app.pay(bookingId).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await charging.opened;
  clock.now = DUE_AT; // the request outlived its age gate
  assert.equal((await app.reconcile()).settled, 1);
  release.open();
  const request = await paying;

  // The job confirmed first; the request's phase 3 found the payment no
  // longer PROCESSING and rolled back. Its client retries with the key.
  assert.ok("error" in request, "the request that lost should not answer");
  assert.equal(statusOfResult(await app.pay(bookingId)), "201 replayed");
  assert.equal(await bookingStatus(bookingId), "CONFIRMED");
  assert.equal(
    await count(`SELECT count(*)::int AS "count" FROM "audit_logs" WHERE "action" = 'BOOKING_CONFIRMED'`),
    1,
  );
  assert.equal(
    await count(`SELECT count(*)::int AS "count" FROM "outbox" WHERE "event_type" = 'booking-confirmed'`),
    1,
  );
  assert.deepEqual(gateway.refunds, []);
  await assertMoneyInvariants(gateway);
});

/** ABANDONED bookings each left with a PROCESSING payment by an unknown charge. */
async function abandonedPayments(gateway: FakePaymentGateway, app: ReturnType<typeof runtime>) {
  for (let index = 0; index < ABANDONED; index += 1) {
    const bookingId = await heldBooking();
    gateway.willCharge({ outcome: "unknown", reason: "timeout" });
    assert.equal(statusOfResult(await app.pay(bookingId, `key-${index}`)), "processing");
  }
  assert.equal(gateway.charges.length, ABANDONED);
}

function jobChargesPerPayment(gateway: FakePaymentGateway): Map<string, number> {
  const perPayment = new Map<string, number>();
  for (const { paymentId } of gateway.charges.slice(ABANDONED)) {
    perPayment.set(paymentId, (perPayment.get(paymentId) ?? 0) + 1);
  }
  return perPayment;
}

test("Race — two reconciliation instances at once on 30 abandoned payments: each payment is charged by exactly one of them and confirmed once (SKIP LOCKED + lease)", async (t) => {
  const clock = { now: PAY_AT };
  // The job's calls take a moment, so both instances are mid-run together.
  const gateway: FakePaymentGateway = createFakePaymentGateway({
    onCharge: async () => {
      if (gateway.charges.length > ABANDONED) {
        await sleep(20);
      }
    },
  });
  const app = runtime(gateway, clock, memoryLogger().logger);
  await abandonedPayments(gateway, app);
  clock.now = DUE_AT;

  const [first, second] = await Promise.all([
    app.reconcilerWith({ batchSize: 10 })(),
    app.reconcilerWith({ batchSize: 10 })(),
  ]);

  const perPayment = jobChargesPerPayment(gateway);
  assert.equal(perPayment.size, ABANDONED);
  assert.ok([...perPayment.values()].every((calls) => calls === 1), "a payment was charged by both");
  assert.equal(first.settled + second.settled, ABANDONED);
  assert.equal(first.failed + second.failed, 0);
  assert.equal(
    await count(`SELECT count(*)::int AS "count" FROM "bookings" WHERE "status" = 'CONFIRMED'`),
    ABANDONED,
  );
  await assertMoneyInvariants(gateway);
  t.diagnostic(`instance A settled ${first.settled}, instance B ${second.settled}`);
});

test("Race (control) — without the lease, a second instance that starts after the first committed its claim charges every payment again; the conditional transitions and the provider's idempotency still keep money and state right", async (t) => {
  const clock = { now: PAY_AT };
  const firstJobCharge = gate();
  const gateway: FakePaymentGateway = createFakePaymentGateway({
    onCharge: async () => {
      if (gateway.charges.length > ABANDONED) {
        firstJobCharge.open();
        await sleep(200);
      }
    },
  });
  const app = runtime(gateway, clock, memoryLogger().logger);
  await abandonedPayments(gateway, app);
  clock.now = DUE_AT;

  const noLease = { leaseMs: 0, batchSize: ABANDONED };
  const first = app.reconcilerWith(noLease)();
  await firstJobCharge.opened; // the first instance's claim has committed
  const [a, b] = await Promise.all([first, app.reconcilerWith(noLease)()]);

  const perPayment = jobChargesPerPayment(gateway);
  const duplicateCalls = [...perPayment.values()].reduce((sum, calls) => sum + calls - 1, 0);
  assert.ok(duplicateCalls > 0, "the control should show duplicate gateway calls");
  assert.equal(a.settled + b.settled, ABANDONED);
  assert.equal(a.failed + b.failed, duplicateCalls);
  assert.equal(gateway.ledger.charged.length, ABANDONED);
  await assertMoneyInvariants(gateway);
  t.diagnostic(`${duplicateCalls} duplicate gateway calls without the lease (0 with it)`);
});

// ---- Key cleanup (BR-PAY-10) ----

test("Key cleanup — once a completed key is deleted after 24 h, the same request is a new request, and the CONFIRMED booking refuses it without a charge", async () => {
  const gateway = createFakePaymentGateway();
  const clock = { now: PAY_AT };
  const app = runtime(gateway, clock, memoryLogger().logger);
  const bookingId = await heldBooking();
  assert.equal(statusOfResult(await app.pay(bookingId)), "201");

  clock.now = new Date(PAY_AT.getTime() + IDEMPOTENCY_KEY_RETENTION_MS - 1);
  assert.equal((await app.cleanupKeys()).deleted, 0);
  clock.now = new Date(PAY_AT.getTime() + IDEMPOTENCY_KEY_RETENTION_MS + 1);
  assert.equal((await app.cleanupKeys()).deleted, 1);
  const repeat = await app.pay(bookingId);

  assert.equal(statusOfResult(repeat), "409");
  assert.equal(
    repeat.outcome === "answered" &&
      (repeat.response.body as { error: { code: string } }).error.code,
    "BOOKING_NOT_PAYABLE",
  );
  assert.equal(gateway.charges.length, 1);
  assert.equal(
    await count(`SELECT count(*)::int AS "count" FROM "payments" WHERE "status" = 'SUCCEEDED'`),
    1,
  );
  await assertMoneyInvariants(gateway);
});

test("the job's queries can use their indexes: IDX_payments_due for the claim, IDX_idempotency_keys_created_at for the cleanup", async () => {
  const plans = await createPostgresTransactionRunner(dataSource).run(async () => {
    const manager = resolveEntityManager(dataSource);
    // Tables this small are always scanned; forbid that to see what the index serves.
    await manager.query("SET LOCAL enable_seqscan = off");
    const explain = async (sql: string) =>
      ((await manager.query(`EXPLAIN ${sql}`)) as Array<{ "QUERY PLAN": string }>)
        .map((row) => row["QUERY PLAN"])
        .join("\n");
    return {
      claim: await explain(
        `SELECT "id" FROM "payments"
         WHERE "status" IN ('PROCESSING', 'REFUND_PENDING') AND "next_attempt_at" <= now()
         ORDER BY "next_attempt_at", "id" LIMIT 20 FOR UPDATE SKIP LOCKED`,
      ),
      cleanup: await explain(
        `SELECT "account_id" FROM "idempotency_keys"
         WHERE "status" = 'COMPLETED' AND "created_at" < now()
         ORDER BY "created_at" LIMIT 500 FOR UPDATE SKIP LOCKED`,
      ),
    };
  });

  assert.match(plans.claim, /IDX_payments_due/);
  assert.match(plans.cleanup, /IDX_idempotency_keys_created_at/);
});
