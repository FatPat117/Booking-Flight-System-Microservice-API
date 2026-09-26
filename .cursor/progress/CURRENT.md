# CURRENT PROGRESS

**Last completed day:** Day 37
**Current day:** Day 37 — Strangler Fig step 2 (dev-complete): `OutboxRepository` on Postgres/TypeORM + transaction context
**Status:** Closed — `PostgresOutboxRepository` + `PostgresTransactionRunner` built and tested against real `booking_db`; Day 36's `PostgresFlightRepository` transaction-join gap fixed in the same pass; not wired into `bootstrap/application.ts`, SQLite still runs production

## Day 37 delivered

```text
transaction-context.ts (AsyncLocalStorage) + PostgresTransactionRunner
  (dataSource.transaction(), NestedTransactionError guard, no promise
  queue — Postgres pools connections, correctness comes from OCC)
PostgresFlightRepository fixed: resolves its repository per call through
  transaction-context instead of once at factory time (Day 36 gap)
OutboxEntity (jsonb, TIMESTAMPTZ, partial index) + PostgresOutboxRepository
  — enqueue() throws OutboxEnqueueOutsideTransactionError outside a
  transaction (deliberate asymmetry with SQLite)
OutboxRepository port made async; ~9 production/test files updated,
  SQLite behavior unchanged
3 new integration tests (Outbox, and cross-repository TransactionRunner:
  commit/rollback/nested-throw/permanent counter-proof)
```

## Biggest catches

```text
1. Day 36's PostgresFlightRepository never actually joined a transaction —
   dataSource.getRepository(FlightEntity) resolved once at factory time
   (closure) always used the pool's default manager. No exception, every
   Day 36 test still passed; only a cross-repository rollback test could
   catch it. Fixed by resolving per call through transaction-context.
2. TypeORM does not detect nested dataSource.transaction() calls on its
   own — would silently open a second, unrelated transaction on another
   pooled connection. Built NestedTransactionError ourselves.
3. OutboxEntity.payload had to be `any`, not `unknown` — TypeORM's
   QueryDeepPartialEntity can't type-check an unknown-typed jsonb column.
   Domain OutboxEntry.payload stays unknown; the any is narrow, at the
   ORM boundary only.
4. The 3 Postgres integration test files share one real booking_db, and
   Node's test runner runs test FILES concurrently by default — one
   file's TRUNCATE landing mid-transaction in another's test produced
   flaky "current transaction is aborted" failures. Invisible on Day 36
   (only one integration file existed). Fixed with --test-concurrency=1.
```

## Previous day (Day 36) recap

```text
booking_db, FlightEntity + migration, PostgresFlightRepository, first
Postgres integration-test tier; FlightRepository + TransactionRunner made
async (required, pg has no sync driver) with SQLite behavior preserved.
```

## Next

Day 38 — Strangler Fig step 3: migrate `AuditRecorder` to Postgres/TypeORM (dev-complete), reusing this day's transaction-context mechanism, per `docs/migration-plan-postgres.md` Section 5.1 order.
