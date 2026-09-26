# Day 38 — Session Notes

**Date completed:** 2026-09-26
**Theme:** Strangler Fig step 3 (dev-complete): `AuditRecorder` on Postgres/TypeORM,
reusing Day 37's transaction-context mechanism, plus the first integration test that
runs a real use case (`CreateFlight`) through the full Postgres adapter set
**Status:** Completed — `PostgresAuditRecorder` exists, tested against real `booking_db`;
not wired into `bootstrap/application.ts` — SQLite still runs production

## Why this couldn't wait for cutover day

```text
Same reasoning as Day 37's OutboxRepository: AuditRecorder only has value if
record() is atomic with the business write it describes (an audit row that
survives a rollback of the action it logs is a log that lies). Migrating it
now, reusing transaction-context instead of re-deriving it, is the "dev
complete before cutover" discipline this migration has followed since Day 36.
```

## Biggest catches

```text
1. The SqliteTransactionRunner promise-queue-reject scenario (queue getting
   stuck after one transaction rejects) turned out to already be fixed —
   queue is chained via `result.then(() => undefined, () => undefined)`,
   which always resolves regardless of whether `result` did. Added a
   permanent regression test for it anyway (transaction-runner.test.ts):
   it protects behavior nothing else in the suite was asserting directly.

2. The real finding behind "câu hỏi treo #2" (duplicate flight inside a
   Postgres transaction): COMMIT issued against an already-aborted Postgres
   transaction does NOT throw — the server silently performs a ROLLBACK
   instead and returns a plain "ROLLBACK" completion, with no error visible
   to the client. Confirmed two ways: raw psql (`BEGIN; INSERT (dup);
   COMMIT;` prints `ROLLBACK`, not `COMMIT`, as its last line) and a raw
   node `pg` client script (`client.query("COMMIT")` resolves normally after
   a caught 23505, even though nothing was actually committed). Any *other*
   query attempted after the failed INSERT but before COMMIT/ROLLBACK does
   throw ("current transaction is aborted, commands ignored until end of
   transaction block") — it's specifically COMMIT-on-an-aborted-transaction
   that's silent.
   This makes create-flight.ts's shape (return immediately as soon as
   flightRepository.create() reports "duplicate", before touching
   auditRecorder or outboxRepository) load-bearing, not incidental: because
   nothing else runs in that transaction after the failed INSERT, the
   "COMMIT that's actually a ROLLBACK" has nothing to lose, so
   PostgresFlightRepository catching 23505 and returning {outcome:
   "duplicate"} is genuinely safe. The trap this exposes for later: if any
   future use case caught a Postgres error mid-transaction and then tried to
   run further queries or writes before returning, those further queries
   would throw immediately, and if it *only* returned without querying
   again, a silent no-op COMMIT would hide the fact that nothing persisted.
   Confirmed via the new create-flight.postgres.integration.test.ts (created
   -> duplicate -> mid-transaction-failure, all real Postgres, no bypassing
   transaction-context).

3. AuditMetadata (Record<string, string | number | boolean | null>) did NOT
   need the `any` workaround OutboxEntity.payload needed on Day 37 — that
   limitation is specific to an `unknown`-typed jsonb column breaking
   TypeORM's QueryDeepPartialEntity inference. A concrete object type
   type-checks through `.insert()` normally. Confirms the Day 37 workaround
   was scoped correctly (ORM-boundary only) rather than a general "jsonb
   always needs any" rule.
```

## Decisions made this session

```text
CHECK constraints on the new Postgres audit_logs: "loose" (length > 0 only,
  no IN (...) listing concrete action/actor_type values) — this is an
  append-only log whose action/actor_type set grows with every feature;
  AuditAction/AuditActor/AuditTarget (audit-recorder.ts) are the real
  guardrail, enforced by TypeScript at the call site. Matches SQLite's
  existing audit_logs migration, which already chose the same thing.
actor/target: kept split into actor_type/actor_id/target_type/target_id
  columns (not jsonb) — same shape as SQLite; keeps a future
  `WHERE target_type = ? AND target_id = ?` a plain column query. metadata
  alone is jsonb, since its shape varies per action (same reasoning as
  Outbox's payload).
No indexes beyond the primary key on the new audit_logs, unlike SQLite's
  (which carries 3: occurred_at, target, request_id) — nothing in this
  codebase currently reads audit_logs (AuditRecorder only has record(), no
  query method). Index presence/absence is invisible to the application
  layer (unlike AuditActor's value), so this isn't a "change behavior during
  migration" violation — it's a fresh, independent call to not add
  speculative indexes with no query to serve, per this day's own guidance.
PostgresAuditRecorder.record() outside a transaction: throws
  AuditRecordOutsideTransactionError — same reasoning and naming pattern as
  OutboxEnqueueOutsideTransactionError (Day 37): a record() call only exists
  to be atomic with the business write beside it.
AuditActor left untouched (still {type: "admin_api_key", id: "admin"} for
  FLIGHT_CREATED, from Day 34's known intentional leftover) — migrating
  storage and fixing that value are two different changes; mixing them
  would make a future "audit data looks different after cutover" hard to
  attribute to one cause or the other.
```

## Delivered

```text
api/tests/transaction-runner.test.ts — new test: a rejected transaction
  does not block later transactions (confirms already-correct behavior,
  kept as a permanent regression guard)
AuditRecorder port made async (Promise<void>); SqliteAuditRecorder and
  ~13 production/test files updated (create-flight.ts, create-booking.ts,
  cancel-booking.ts, and every inline AuditRecorder fake across the test
  suite), SQLite behavior unchanged
api/src/audit/postgres/audit.entity.ts — actor/target split columns, jsonb
  metadata, TIMESTAMPTZ occurred_at, no unknown/any workaround needed
api/src/postgres/migrations/1790432350000-CreateAuditLogs.ts — loose CHECK
  constraints, no indexes (see decisions above)
api/src/audit/postgres/postgres-audit-recorder.ts — implements
  AuditRecorder; record() throws AuditRecordOutsideTransactionError outside
  a transaction
api/src/postgres/data-source.ts — registers AuditEntity + migration
2 new integration test files:
  tests/integration/postgres-audit-recorder.integration.test.ts (record
  inside/outside a transaction)
  tests/integration/create-flight.postgres.integration.test.ts — runs the
  real createCreateFlight use case wired to every Postgres adapter
  (Flight + Audit + Outbox + TransactionRunner): created (1 row each table),
  duplicate (resolves "duplicate", no extra audit/outbox rows), and
  mid-transaction failure (rolls back all 3 tables together)
```

## Verified end to end

```text
npm run typecheck / typecheck:test (root, all workspaces) -> clean
npm test (root) -> 176 (api, +1 from the new promise-queue test) + 4
  (flight-notifier) + 12 (identity) pass — no silent test drop
npm run postgres:migration:run -> audit_logs table created in booking_db
\d audit_logs -> actor/target split columns, jsonb metadata, timestamptz
  occurred_at, loose length-only CHECK constraints, no extra indexes
npm run test:integration (--test-concurrency=1) -> 18/18 pass (13 carried
  over from Day 37 + 2 Audit + 3 CreateFlight end-to-end), 3 runs in a row
  with no flakiness
```

## Not today

```text
No cutover — bootstrap/application.ts still constructs Sqlite* repositories
  and SqliteTransactionRunner; production behavior unchanged
BookingRepository not migrated (Strangler Fig step 4, per
  docs/migration-plan-postgres.md Section 5.1 order) — the highest-risk
  step: OCC on reserveSeat/cancel, Day 26/28's race test needs to run again
  against real Postgres
AuditActor's stale {type: "admin_api_key"} value for FLIGHT_CREATED not
  fixed — deliberately deferred, see decisions above
No SKIP LOCKED for the outbox relay (single api instance, Day 17 limitation)
```
