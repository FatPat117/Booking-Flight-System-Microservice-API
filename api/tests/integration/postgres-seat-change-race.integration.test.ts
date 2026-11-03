import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { parseSeatPosition } from "../../src/aircraft/seat-position.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { cancellableUntil } from "../../src/bookings/booking-lifecycle.js";
import { createCancelBooking } from "../../src/bookings/cancel-booking.js";
import { createChangeSeat } from "../../src/bookings/change-seat.js";
import { createCreateBooking } from "../../src/bookings/create-booking.js";
import { createExpireHolds } from "../../src/bookings/expire-holds.js";
import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresIdempotencyRepository } from "../../src/idempotency/postgres/postgres-idempotency-repository.js";
import type { Logger } from "../../src/observability/logger.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { createPayForBooking } from "../../src/payments/pay-for-booking.js";
import { createPostgresPaymentRepository } from "../../src/payments/postgres/postgres-payment-repository.js";
import { createReconcilePayments } from "../../src/payments/reconcile-payments.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { isDeadlockDetected } from "../../src/postgres/postgres-errors.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import { createFakePaymentGateway, type FakePaymentGateway } from "../fakes/in-memory.js";
import { nextBookingReference } from "../fixtures/bookings.js";
import { FIXTURE_FARES, makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { assertGlobalInvariants, findInvariantViolations } from "./invariants.js";

/**
 * Day 50 — seat change and cancelling a paid booking, raced on Postgres
 * (Decision 16, lock-order table). Every scenario ends with the global
 * invariants (invariants.ts) against the fake provider's ledger: seats,
 * passengers, fare classes and money all agree, whatever the interleaving.
 *
 * A gate is a transaction of the test's own holding one seat row, so the
 * racers line up behind it in a known order; QUEUE_MS gives a statement
 * time to reach its lock and wait there.
 */

let dataSource: DataSource;

const OWNER = { accountId: "11111111-1111-4111-8111-111111111111" };
const OWNER_SCOPE = { kind: "owner", accountId: OWNER.accountId } as const;
const NOW = new Date("2026-07-20T00:00:00.000Z");
const QUEUE_MS = 50;
const ROUNDS = 10;
const silent: Logger = { info() {}, warn() {}, error() {} };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seat(code: string) {
  const position = parseSeatPosition(code);
  assert.ok(position, code);
  return position;
}

function runtimeDependencies(
  gateway: FakePaymentGateway = createFakePaymentGateway(),
  clock: { now: Date } = { now: NOW },
) {
  return {
    bookingRepository: createPostgresBookingRepository(dataSource),
    paymentRepository: createPostgresPaymentRepository(dataSource),
    idempotencyRepository: createPostgresIdempotencyRepository(dataSource),
    paymentGateway: gateway,
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    logger: silent,
    generateId: () => crypto.randomUUID(),
    generateReference: nextBookingReference,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    generatePaymentId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => clock.now,
    reconcileAfterMs: 40_000,
  };
}

function runtime(gateway: FakePaymentGateway, clock: { now: Date }) {
  const dependencies = runtimeDependencies(gateway, clock);
  const pay = createPayForBooking(dependencies);
  const change = createChangeSeat(dependencies);
  const cancel = createCancelBooking(dependencies);

  return {
    hold: createCreateBooking(dependencies),
    pay: (bookingId: string) =>
      pay(bookingId, OWNER_SCOPE, OWNER, {
        idempotencyKey: `key-${bookingId}`,
        fingerprint: `pay ${bookingId}`,
        paymentMethodToken: "tok_success",
        amount: FIXTURE_FARES.ECONOMY,
      }),
    change: (bookingId: string, to: string) =>
      change(bookingId, 1, seat(to), OWNER_SCOPE, OWNER),
    cancel: (bookingId: string) => cancel(bookingId, OWNER_SCOPE, OWNER),
    reconcile: createReconcilePayments({
      ...dependencies,
      leaseMs: 40_000,
      batchSize: 20,
      maxBatches: 5,
    }),
    expire: createExpireHolds({ ...dependencies, batchSize: 50, maxBatches: 20 }),
  };
}

type Runtime = ReturnType<typeof runtime>;

/** An economy-only flight (120 seats, rows 1–20), departing in 2027. */
async function createFlight(overrides: Parameters<typeof makeFlight>[0] = {}): Promise<string> {
  const flight = makeFlight(overrides);
  await createPostgresFlightRepository(dataSource).create(flight);
  return flight.id;
}

/** A one-passenger booking on `code`, HELD. */
async function held(app: Runtime, flightId: string, code: string): Promise<string> {
  const result = await app.hold(flightId, { passengers: [{ name: `P${code}`, seat: code }] }, OWNER);
  assert.equal(result.outcome, "created", JSON.stringify(result));
  return result.outcome === "created" ? result.booking.id : "";
}

/** …and paid: CONFIRMED, its seat BOOKED, charged once by the fake provider. */
async function confirmed(app: Runtime, flightId: string, code: string): Promise<string> {
  const bookingId = await held(app, flightId, code);
  const paid = await app.pay(bookingId);
  assert.equal(paid.outcome === "answered" && paid.response.status, 201, JSON.stringify(paid));
  return bookingId;
}

async function seatOf(flightId: string, code: string) {
  const position = seat(code);
  const [row] = (await dataSource.query(
    `SELECT "status", "booking_id" FROM "flight_seats"
     WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3`,
    [flightId, position.row, position.letter],
  )) as Array<{ status: string; booking_id: string | null }>;
  return row;
}

async function bookingStatus(bookingId: string): Promise<string> {
  const [row] = (await dataSource.query(`SELECT "status" FROM "bookings" WHERE "id" = $1`, [bookingId])) as Array<{ status: string }>;
  return row?.status ?? "missing";
}

/** Holds one seat row in a transaction of its own until released. */
async function gateSeat(flightId: string, code: string): Promise<() => Promise<void>> {
  const position = seat(code);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  await runner.query(
    `SELECT 1 FROM "flight_seats" WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3 FOR UPDATE`,
    [flightId, position.row, position.letter],
  );
  return async () => {
    await runner.commitTransaction();
    await runner.release();
  };
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

// ---- A / A': two passengers swapping crosswise ----

/**
 * X sits on 12A and wants 14C; Y sits on 14C and wants 12A. A gate holds
 * 12A; X's change starts and queues on it, then Y's. The gate opens.
 */
async function crossSwap(
  app: Runtime,
  swap: (bookingId: string, own: string, target: string) => Promise<unknown>,
) {
  const flightId = await createFlight();
  const x = await confirmed(app, flightId, "12A");
  const y = await confirmed(app, flightId, "14C");

  const openGate = await gateSeat(flightId, "12A");
  const first = swap(x, "12A", "14C");
  await sleep(QUEUE_MS);
  const second = swap(y, "14C", "12A");
  await sleep(QUEUE_MS);
  await openGate();

  return Promise.allSettled([first, second]);
}

test("A — two passengers swap crosswise (12A→14C, 14C→12A): both finish with seat-unavailable, never 40P01, round after round", async (t) => {
  const gateway = createFakePaymentGateway();
  const app = runtime(gateway, { now: NOW });

  for (let round = 0; round < ROUNDS; round += 1) {
    const settled = await crossSwap(app, (bookingId, _own, target) => app.change(bookingId, target));

    for (const result of settled) {
      assert.equal(result.status, "fulfilled", String(result.status === "rejected" && result.reason));
      assert.equal(
        result.status === "fulfilled" && (result.value as { outcome: string }).outcome,
        "seat-unavailable",
      );
    }
    await assertGlobalInvariants(dataSource, gateway.ledger);
  }
  t.diagnostic(`${ROUNDS} rounds: 0 deadlocks, ${2 * ROUNDS} seat-unavailable`);
});

/**
 * Control for A — exists only here, never in src/. The swap's lock step as
 * "own seat first, then the target": the order a change written as "free
 * mine, take theirs" would lock in.
 */
async function lockOwnSeatFirst(flightId: string, own: string, target: string) {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    for (const code of [own, target]) {
      const position = seat(code);
      await runner.query(
        `SELECT 1 FROM "flight_seats" WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3 FOR UPDATE`,
        [flightId, position.row, position.letter],
      );
    }
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

test("A' (control) — the same crosswise swap locking the own seat first deadlocks (40P01)", async (t) => {
  const gateway = createFakePaymentGateway();
  const app = runtime(gateway, { now: NOW });
  // Each deadlock costs deadlock_timeout (1 s).
  const rounds = 5;
  let deadlocks = 0;

  for (let round = 0; round < rounds; round += 1) {
    let flightId = "";
    const settled = await crossSwap(app, async (bookingId, own, target) => {
      if (flightId === "") {
        const [row] = (await dataSource.query(`SELECT "flight_id" FROM "bookings" WHERE "id" = $1`, [bookingId])) as Array<{ flight_id: string }>;
        flightId = row?.flight_id ?? "";
      }
      return lockOwnSeatFirst(flightId, own, target);
    });

    for (const result of settled.filter((r) => r.status === "rejected")) {
      assert.ok(isDeadlockDetected((result as PromiseRejectedResult).reason), String((result as PromiseRejectedResult).reason));
      deadlocks += 1;
    }
  }

  // X queued on the gate holding nothing; Y took 14C and queued on 12A.
  // The gate opened: X took 12A and asked for 14C — a cycle, every round.
  assert.equal(deadlocks, rounds, "every round should deadlock");
  t.diagnostic(`${rounds} rounds: ${deadlocks} deadlocks`);
});

// ---- B: a seat change and a new hold want the same free seat ----

test("B — a seat change to 14C and a new booking holding 14C at once: exactly one gets it, no seat has two owners", async (t) => {
  const gateway = createFakePaymentGateway();
  const app = runtime(gateway, { now: NOW });
  const tally = { change: 0, hold: 0 };

  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight();
    const mover = await confirmed(app, flightId, "3A");

    const [changed, booked] = await Promise.all([
      app.change(mover, "14C"),
      app.hold(flightId, { passengers: [{ name: "Racer", seat: "14C" }] }, OWNER),
    ]);

    const changeWon = changed.outcome === "changed";
    const holdWon = booked.outcome === "created";
    assert.ok(changeWon !== holdWon, `${changed.outcome} / ${booked.outcome}`);
    assert.equal(changeWon ? booked.outcome : changed.outcome, changeWon ? "seats-unavailable" : "seat-unavailable");
    const target = await seatOf(flightId, "14C");
    assert.equal(target?.status, changeWon ? "BOOKED" : "HELD");
    tally[changeWon ? "change" : "hold"] += 1;
    await assertGlobalInvariants(dataSource, gateway.ledger);
  }
  t.diagnostic(`${ROUNDS} rounds: change won ${tally.change}, hold won ${tally.hold}`);
});

// ---- C: cancel and seat change of the same booking ----

test("C — cancel and seat change of one paid booking at once: one valid order, the cancelled booking keeps no seat and is refunded", async (t) => {
  const gateway = createFakePaymentGateway();
  const app = runtime(gateway, { now: NOW });
  const tally = { changeFirst: 0, cancelFirst: 0 };

  for (let round = 0; round < ROUNDS; round += 1) {
    const flightId = await createFlight();
    const bookingId = await confirmed(app, flightId, "3A");

    const [changed, cancelled] = await Promise.all([app.change(bookingId, "9F"), app.cancel(bookingId)]);

    assert.equal(cancelled.outcome, "cancelled");
    // Either the change ran first (and the cancel released 9F), or the
    // cancel did (and the change found nothing to change).
    assert.ok(["changed", "not-changeable"].includes(changed.outcome), changed.outcome);
    tally[changed.outcome === "changed" ? "changeFirst" : "cancelFirst"] += 1;
    for (const code of ["3A", "9F"]) {
      assert.deepEqual(await seatOf(flightId, code), { status: "AVAILABLE", booking_id: null });
    }
    assert.equal(await bookingStatus(bookingId), "CANCELLED");
    await assertGlobalInvariants(dataSource, gateway.ledger);
  }
  t.diagnostic(`${ROUNDS} rounds: change first ${tally.changeFirst}, cancel first ${tally.cancelFirst}`);
});

/**
 * The interleaving that broke the Day 48B cancel, forced: a seat change
 * 3A → 9F has run and holds the booking (its transaction still open); the
 * cancel starts and queues on the booking; then the change commits.
 */
async function cancelDuringSeatChange(cancel: (bookingId: string) => Promise<unknown>) {
  const gateway = createFakePaymentGateway();
  const app = runtime(gateway, { now: NOW });
  const flightId = await createFlight();
  const bookingId = await confirmed(app, flightId, "3A");

  let commit!: () => void;
  const committed = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const change = createPostgresTransactionRunner(dataSource).run(async () => {
    const result = await createPostgresBookingRepository(dataSource).changeSeat(
      bookingId, 1, seat("9F"), OWNER_SCOPE, NOW,
    );
    assert.equal(result.outcome, "changed");
    await committed;
  });
  await sleep(QUEUE_MS);
  const cancelled = cancel(bookingId);
  await sleep(QUEUE_MS);
  commit();
  await Promise.all([change, cancelled]);

  return { flightId, gateway };
}

test("C (forced) — a cancel that starts while a seat change holds the booking releases the new seat once the change commits", async () => {
  const { flightId, gateway } = await cancelDuringSeatChange((bookingId) =>
    createCancelBooking(runtimeDependencies())(bookingId, OWNER_SCOPE, OWNER),
  );

  assert.deepEqual(await seatOf(flightId, "9F"), { status: "AVAILABLE", booking_id: null });
  assert.deepEqual(await seatOf(flightId, "3A"), { status: "AVAILABLE", booking_id: null });
  await assertGlobalInvariants(dataSource, gateway.ledger);
});

/**
 * Control for C — exists only here, never in src/. The Day 48B/49 cancel:
 * one statement, its booking lock taken by the UPDATE inside it, so its
 * snapshot predates the change it waited for.
 */
function cancelInOneStatement(bookingId: string) {
  return dataSource.query(
    `WITH cancelled AS (
       UPDATE "bookings" SET "status" = 'CANCELLED'
       WHERE "id" = $1 AND "status" = 'CONFIRMED'
       RETURNING "id"
     ), locked AS (
       SELECT seat."flight_id", seat."row", seat."letter" FROM "flight_seats" seat
       WHERE seat."booking_id" IN (SELECT "id" FROM cancelled)
       ORDER BY seat."flight_id", seat."row", seat."letter"
       FOR UPDATE
     )
     UPDATE "flight_seats" seat SET "status" = 'AVAILABLE', "booking_id" = NULL
     FROM locked
     WHERE seat."flight_id" = locked."flight_id"
       AND seat."row" = locked."row" AND seat."letter" = locked."letter"`,
    [bookingId],
  );
}

test("C' (control) — the one-statement cancel, same interleaving: the booking is CANCELLED and the new seat stays BOOKED for it", async () => {
  const { flightId } = await cancelDuringSeatChange(cancelInOneStatement);

  // It released 3A as its old snapshot saw it — already free — and never saw 9F.
  assert.equal((await seatOf(flightId, "9F"))?.status, "BOOKED");
  const violations = await findInvariantViolations(dataSource);
  assert.ok(
    violations.some((violation) => violation.startsWith("seat status agrees with its booking")),
    JSON.stringify(violations),
  );
});

// ---- D: the 24 h boundary, on Postgres ----

test("D — cancelling at exactly departure − 24 h is refused and writes nothing; 1 ms earlier it cancels and starts the refund", async () => {
  const gateway = createFakePaymentGateway();
  const clock = { now: NOW };
  const app = runtime(gateway, clock);
  const departure = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
  const flightId = await createFlight({
    departureAt: departure.toISOString(),
    arrivalAt: new Date(departure.getTime() + 2 * 60 * 60 * 1000).toISOString(),
  });
  const late = await confirmed(app, flightId, "3A");
  const early = await confirmed(app, flightId, "3B");
  const windowCloses = new Date(cancellableUntil(departure.toISOString()));

  clock.now = windowCloses;
  assert.deepEqual(await app.cancel(late), {
    outcome: "cancellation-window-closed",
    cancellableUntil: windowCloses.toISOString(),
  });
  clock.now = new Date(windowCloses.getTime() - 1);
  assert.equal((await app.cancel(early)).outcome, "cancelled");

  assert.equal(await bookingStatus(late), "CONFIRMED");
  assert.equal((await seatOf(flightId, "3A"))?.status, "BOOKED");
  assert.equal(await bookingStatus(early), "CANCELLED");
  await assertGlobalInvariants(dataSource, gateway.ledger);
});

// ---- E: what a seat change leaves for later releases ----

test("E — after a seat change, cancelling releases the new seat and the old one stays free; a HELD booking cannot change, and expiry frees the seat it holds", async () => {
  const gateway = createFakePaymentGateway();
  const clock = { now: NOW };
  const app = runtime(gateway, clock);
  const flightId = await createFlight();
  const moved = await confirmed(app, flightId, "3A");
  const unpaid = await held(app, flightId, "4A");

  assert.equal((await app.change(moved, "8D")).outcome, "changed");
  assert.equal((await app.change(unpaid, "4B")).outcome, "not-changeable");
  assert.equal((await app.cancel(moved)).outcome, "cancelled");
  clock.now = new Date(NOW.getTime() + 15 * 60 * 1000);
  assert.equal((await app.expire()).expired, 1);

  for (const code of ["3A", "8D", "4A", "4B"]) {
    assert.deepEqual(await seatOf(flightId, code), { status: "AVAILABLE", booking_id: null }, code);
  }
  assert.equal((await app.reconcile()).refunded, 1);
  await assertGlobalInvariants(dataSource, gateway.ledger);
});

// ---- F: a paid cancel while reconciliation runs ----

test("F — cancelling paid bookings while two reconciliation runs go on: each is refunded exactly once", async (t) => {
  const clock = { now: NOW };
  const gateway = createFakePaymentGateway({ onRefund: () => sleep(5) });
  const app = runtime(gateway, clock);
  const flightId = await createFlight();
  const bookings = await Promise.all(
    Array.from({ length: ROUNDS }, (_, index) => confirmed(app, flightId, `${index + 1}A`)),
  );

  const results = await Promise.all([
    ...bookings.map((bookingId) => app.cancel(bookingId)),
    app.reconcile(),
    sleep(10).then(() => app.reconcile()),
  ]);
  // Whatever the job did not see in flight, its next run finishes.
  await app.reconcile();

  assert.ok(results.slice(0, ROUNDS).every((result) => (result as { outcome: string }).outcome === "cancelled"));
  assert.equal(gateway.ledger.refunded.length, ROUNDS);
  assert.equal(
    (await dataSource.query(`SELECT count(*)::int AS "n" FROM "payments" WHERE "status" = 'REFUNDED'`))[0].n,
    ROUNDS,
  );
  await assertGlobalInvariants(dataSource, gateway.ledger);
  t.diagnostic(`${ROUNDS} paid cancels, ${gateway.ledger.refunded.length} refunds`);
});
