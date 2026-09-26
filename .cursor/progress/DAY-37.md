# Day 37 — Session Notes

**Date completed:** 2026-09-26
**Theme:** Strangler Fig step 2 (dev-complete): `OutboxRepository` on Postgres/TypeORM + a
real transaction-context mechanism for Postgres repositories
**Status:** Completed — `PostgresOutboxRepository` + `PostgresTransactionRunner` exist,
tested against real `booking_db`; `PostgresFlightRepository`'s Day 36 gap (never actually
joined a transaction) fixed in the same pass; not wired into `bootstrap/application.ts` —
SQLite still runs production

## Why this couldn't wait for cutover day

```text
OutboxRepository only has value if enqueue() is atomic with the business
write beside it (ADR-001) — a PostgresOutboxRepository that can't prove it
joins the same transaction as PostgresFlightRepository isn't "dev-complete",
it's untested. Building the transaction-context mechanism now, while
migrating the second repository, means the third and fourth (Audit,
Booking) reuse it instead of each re-deriving it.
```

## Why AsyncLocalStorage (not a manager parameter, not per-transaction repos)

```text
Three options existed: (A) pass EntityManager as an explicit parameter to
every repository method — leaks a TypeORM concept into the port,
violating the Day 6 rule that a repository interface must not know its
storage type; (B) have TransactionRunner hand back a set of
transaction-scoped repositories instead of running a plain callback —
correct, but changes every use case's signature (CreateFlight,
CreateBooking, CancelBooking); (C) AsyncLocalStorage, reusing the same
mechanism already proven twice in this codebase (requestId/correlationId,
Day 29; authenticatedUser, Day 33). Chose C — port and use cases stay
unchanged, matching "swap the implementation, not the contract."

Trade-off accepted: a repository called outside run() silently uses the
non-transactional manager. Correct for findUnpublished/markPublished
(the relay calls them outside any transaction on purpose); risky for
enqueue() if someone forgets to wrap it — which is why enqueue()
specifically throws instead of silently degrading (see below).
```

## Why no promise queue in PostgresTransactionRunner (unlike SqliteTransactionRunner)

```text
SQLite's queue exists because BEGIN/COMMIT share one physical connection —
two transactions can never truly overlap on it. Postgres borrows a
separate connection per transaction from the pool, so concurrent
transactions are the normal case; correctness under contention still
comes from OCC (conditional UPDATE, ADR-004), not from serializing writes.
Same port, two implementations, two entirely different concurrency
mechanisms underneath it — the point of the port/adapter boundary.
```

## Biggest catches

```text
1. Day 36's PostgresFlightRepository never actually joined a transaction —
   it resolved `dataSource.getRepository(FlightEntity)` once at factory
   time (closure), which always used the pool's default manager. No
   exception, every Day 36 test still passed; only a cross-repository
   rollback test could catch it. Fixed by resolving the repository through
   transaction-context on every method call instead of once at factory
   time. Same fix pattern applied to PostgresOutboxRepository from the
   start.

2. TypeORM does NOT protect against nested dataSource.transaction() calls
   — called from `dataSource` (not an already-bound manager) it always
   opens a new connection from the pool, silently starting an unrelated
   second transaction. Had to build NestedTransactionError ourselves,
   detected via transaction-context's isInTransaction().

3. OutboxEntity.payload had to be typed `any`, not `unknown` — TypeORM's
   QueryDeepPartialEntity mapped type can't handle an unknown-typed jsonb
   column (breaks .insert()'s typing). Domain OutboxEntry.payload stays
   `unknown`; the ORM-boundary `any` is narrow and commented, not a broad
   escape hatch.

4. The 3 Postgres integration test files (Flight, Outbox, TransactionRunner)
   all hit the SAME real booking_db — Node's test runner runs multiple
   test FILES concurrently by default, so one file's TRUNCATE could land
   mid-transaction in another file's test, producing flaky
   "current transaction is aborted" failures. Invisible on Day 36 (only
   one integration file existed then). Fixed with
   `--test-concurrency=1` on the test:integration script — these tests
   share physical state on purpose and were never meant to run in
   parallel, unlike the unit suite (isolated :memory: SQLite per test).
```

## Decisions made this session

```text
Outbox payload column: jsonb, not text — TypeORM's Postgres driver
  stringifies on write and pg auto-parses jsonb back to a JS value on
  read, so postgres-outbox-repository.ts needs no manual
  JSON.stringify/parse, unlike sqlite-outbox-repository.ts. jsonb also
  rejects invalid JSON at insert time instead of failing later in the
  relay job.
Outbox created_at/published_at: TIMESTAMPTZ, not text — Day 35 left this
  open for Outbox ("less reason to change"); since this table is written
  fresh (not a retrofit), decided TIMESTAMPTZ for the same reason already
  applied to flights (removes the "ISO string ordering happens to match
  chronological order" assumption at the exact place — ORDER BY
  created_at — that depends on it).
enqueue() outside a transaction: throws OutboxEnqueueOutsideTransactionError
  — deliberate asymmetry with SqliteOutboxRepository (no such check).
  Matches this codebase's existing "fail loudly on programmer misuse"
  pattern (NestedTransactionError, setAuthenticatedUser). Postgres can
  detect this cheaply via transaction-context; SQLite can't without
  adopting the same machinery for a problem it hasn't caused a bug yet.
```

## Delivered

```text
api/src/postgres/transaction-context.ts — AsyncLocalStorage for the
  active transaction's EntityManager, separate from
  observability/request-context.ts (transaction lifetime != request
  lifetime)
api/src/transactions/postgres-transaction-runner.ts — dataSource.transaction()
  (TypeORM's own commit/rollback/release, no manual try/finally),
  NestedTransactionError guard, no promise queue
api/src/flights/postgres/postgres-flight-repository.ts — fixed to resolve
  its repository per call through transaction-context (was: once, at
  factory time)
api/src/outbox/postgres/outbox.entity.ts + migration
  1790428672000-CreateOutbox.ts — jsonb, TIMESTAMPTZ, partial index
api/src/outbox/postgres/postgres-outbox-repository.ts — implements
  OutboxRepository; enqueue() throws outside a transaction
OutboxRepository port made async (SQLite behavior unchanged); create-flight.ts,
  create-booking.ts, cancel-booking.ts, outbox-relay-job.ts,
  sqlite-outbox-repository.ts, noop-outbox-repository.ts, and ~9 test
  files updated
3 new integration test files: postgres-outbox-repository, and
  postgres-transaction-runner (commit, rollback, nested-throw, and a
  permanent counter-proof test reproducing the pre-fix bug)
1 new unit test file: transaction-context.test.ts (context survives
  await, doesn't leak after the callback returns)
```

## Verified end to end

```text
npm run typecheck / typecheck:test (root, all workspaces) -> clean
npm test (root) -> 175 (api) + 12 (identity) + 4 (flight-notifier) pass,
  same counts as before Day 37 (no silent test drop)
npm run postgres:migration:run -> outbox table created in booking_db
\d outbox -> jsonb, timestamptz columns, partial index
EXPLAIN ... WHERE published_at IS NULL ORDER BY created_at ASC LIMIT ...
  -> Bitmap Index Scan on idx_outbox_unpublished (planner actually uses it)
npm run test:integration (--test-concurrency=1) -> 13/13 pass, 3 runs in
  a row with no flakiness, including the counter-proof test
```

## Not today

```text
No cutover — bootstrap/application.ts still constructs Sqlite* repositories
  and SqliteTransactionRunner; production behavior unchanged
AuditRecorder, BookingRepository not migrated (Strangler Fig steps 3-4,
  per docs/migration-plan-postgres.md Section 5.1 order)
No SKIP LOCKED for the outbox relay (single api instance, Day 17 limitation)
```
