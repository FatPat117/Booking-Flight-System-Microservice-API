# CURRENT PROGRESS

**Last completed day:** Day 38
**Current day:** Day 38 — Strangler Fig step 3 (dev-complete): `AuditRecorder` on Postgres/TypeORM + first end-to-end use-case integration test
**Status:** Closed — `PostgresAuditRecorder` built and tested against real `booking_db`; `create-flight.postgres.integration.test.ts` runs the real `createCreateFlight` use case through every Postgres adapter (Flight + Audit + Outbox + TransactionRunner); not wired into `bootstrap/application.ts`, SQLite still runs production

## Day 38 delivered

```text
Permanent regression test confirming SqliteTransactionRunner's promise
  queue already survives a rejected transaction (no fix needed — the queue
  was already decoupled from each call's result)
AuditRecorder port made async; ~13 production/test files updated,
  SQLite behavior unchanged
AuditEntity (actor/target split columns, jsonb metadata, TIMESTAMPTZ) +
  migration (loose length-only CHECK, no speculative indexes) +
  PostgresAuditRecorder — record() throws
  AuditRecordOutsideTransactionError outside a transaction (same pattern
  as Outbox's enqueue())
create-flight.postgres.integration.test.ts — first test running a real use
  case (createCreateFlight) wired to every Postgres adapter: created,
  duplicate, and mid-transaction-failure, all asserted against real DB rows
```

## Biggest catches

```text
1. COMMIT against an already-aborted Postgres transaction does not throw —
   the server silently performs a ROLLBACK and returns a plain "ROLLBACK"
   completion with no client-visible error. Confirmed via raw psql and a
   raw node pg script. create-flight.ts's duplicate path is safe from this
   only because it returns immediately after flightRepository.create()
   reports "duplicate", before any other query in that transaction — a
   future use case that kept querying after catching a Postgres error
   would hit "current transaction is aborted, commands ignored" instead.
2. AuditMetadata (a concrete Record<...> type) did not need Outbox's `any`
   workaround — that limitation is specific to `unknown`-typed jsonb
   columns breaking TypeORM's QueryDeepPartialEntity, not jsonb in general.
```

## Previous day (Day 37) recap

```text
transaction-context.ts (AsyncLocalStorage) + PostgresTransactionRunner;
fixed Day 36's PostgresFlightRepository transaction-join gap; OutboxEntity
+ PostgresOutboxRepository (jsonb, TIMESTAMPTZ, partial index,
enqueue()-outside-transaction guard); OutboxRepository port made async.
```

## Next

Day 39 — Strangler Fig step 4: migrate `BookingRepository` to Postgres/TypeORM (dev-complete) — the highest-risk step (OCC on `reserveSeat`/`cancel`, Day 26/28's race test needs to run again against real Postgres), per `docs/migration-plan-postgres.md` Section 5.1 order.
