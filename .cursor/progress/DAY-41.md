# Day 41 — Session Notes

**Date started:** 2026-10-04
**Theme:** Remove `node:sqlite` from `api` + decide the test strategy without a SQLite adapter
**Status:** Code complete — publisher reconnects in-process after a RabbitMQ restart; `node:sqlite` fully removed from `api`;
unit/HTTP tier runs on in-memory fakes, database semantics on Postgres (ADR-005); `BookingRepository` contract test runs on both.
Pending user verification before commit: `npm run test:integration` (expected 42) + e2e smoke on docker-compose.

## Step 0 — RabbitMQ restart: publisher recovery (carried over from Day 40 catch #4)

```text
Verified first, before changing anything (user ran it against the real
docker-compose stack, no npm run dev processes live):
  flight-notifier: recovered by design — crashed on the broker restart
    (RestartCount=1), restart: unless-stopped brought it back,
    connectConsumerWithRetry reconnected.
  app: did NOT recover. The process never crashed (RestartCount=0), so
    the restart policy never fired; the publisher kept a dead channel and
    the relay logged outbox_publish_failed "Channel closed" every 5s
    forever. /live stayed healthy, so Docker had no signal either. No data
    lost — the outbox row sat at published_at IS NULL and was delivered
    the moment the app was restarted by hand. The outbox did its job; the
    publisher was the gap.

Fix (user's choice): in-process, lazy reconnect in rabbitmq-publisher.ts.
  An unexpected connection/channel close drops the session
  (rabbitmq_connection_lost); the next publish() opens a new one
  (rabbitmq_reconnected). Concurrent publishes share one reconnect
  attempt. No background timer — a failed reconnect fails that publish,
  the row stays unpublished, and the relay's 5s interval is the retry
  cadence. close() clears the session before closing, so graceful
  shutdown is never logged as "lost" and never reconnects.
  Port, connectPublisherWithRetry (startup stays fail-fast), relay job and
  bootstrap unchanged. 4 unit tests with a hand-written EventEmitter fake
  (mutation-checked: removing the invalidation fails 3 of 4).

Trade-off, stated: the publisher now recovers in-process while
  flight-notifier still recovers by crash + restart policy. Two recovery
  styles in one codebase. Crash-only for the publisher was the
  alternative (smaller code, one style) but it would kill in-flight HTTP
  requests on every broker blip, for a dependency the HTTP path does not
  even touch (the outbox decouples it).

Re-verified on the stack: rabbitmq restart -> connection_lost
  (channel_closed) immediately; reconnected only when flight verify-3
  needed publishing; 0 outbox_publish_failed; notifier consumed verify-3;
  app RestartCount 0; no stuck outbox rows; docker compose stop app ->
  exit code 0.
npm test (api): 182 -> 186 (+4 publisher tests). New baseline: 186.
```

## Step 1 — Inventory and classification (before deleting anything)

Groups: **(a)** move to in-memory fakes · **(b)** a Postgres equivalent already exists → delete · **(c)** no longer meaningful → delete.

### Unit test files that touch SQLite

| File | Tests | Group | Replacement / reason |
|---|---|---|---|
| `sqlite-booking-repository.test.ts` | 6 | b | `postgres-booking-repository.integration` (6) + the new contract |
| `sqlite-flight-repository.test.ts` | 4 | b | `postgres-flight-repository.integration` (4) |
| `sqlite-outbox-repository.test.ts` | 5 | b | `postgres-outbox-repository.integration` (5) |
| `transaction-runner.test.ts` | 4 | b | `postgres-transaction-runner.integration` (4) |
| `audit-recorder.test.ts` | 1 | b | `postgres-audit-recorder.integration` (2) |
| `migration-runner.test.ts` | 5 | c | The hand-written SQLite runner is gone; TypeORM migrations are covered by `application.integration` |
| `health-checks.test.ts` | 2 | c | Tests the SQLite adapter. **`PostgresHealthChecks` has no automated test today** → add `postgres-health-checks.integration.test.ts` (2) so this isn't a silent loss |
| `create-booking.test.ts` › "concurrent bookings with one seat…" | 1 | b | Cannot fail on a fake (single-threaded JS); `postgres-booking-race` Test A |
| `cancel-booking.test.ts` › "concurrent double-cancel…" | 1 | b | Same reason; `postgres-booking-race` Test B |
| `flights.api.test.ts` › "flight persists after closing and reopening the same database file" | 1 | c | A database file is a SQLite concept |
| `flights.api.test.ts` › "two apps sharing one database file…" | 1 | c | Same |
| `flights.api.test.ts` › "isolation A" / "isolation B" | 2 | c | Proved separate `:memory:` DBs don't leak; with a fake per test this is trivially true, and "empty collection" is already its own test |
| `flights.api.test.ts` › "rolls back flight creation when audit recording fails" | 1 | b | Rollback = database semantics → `create-flight.postgres` "mid-transaction failure"; the 500 mapping is already covered by "unexpected errors return generic 500…" |
| `create-booking.test.ts` (other 4), `cancel-booking.test.ts` (other 3) | 7 | a | Fakes; assert via fake state instead of SQL |
| `flights.api.test.ts` (other 50 incl. subtests) | 50 | a | Swap `createTestContext` wiring; 8 direct SQL assertions (audit) → `audit.records` |
| `bookings.api`, `health.api`, `request-observability`, `verify-jwt` | 6+4+4+7 | a | Wiring only, no direct SQL |

**Expected unit-test delta:** remove **34** (b: 15+4+1+1+1+1 = 23, c: 5+2+1+1+2 = 11) out of the 186 baseline → **152**, plus the new
`BookingRepository` contract tests run against the fake (count fixed in Step 3). Integration: 33 baseline + 2 Postgres health
checks + the contract run against Postgres.

No deleted test has subtests (verified — the 23 subtests in `flights.api` all live in group-a validation tests).

### Non-test SQLite traces

| Where | What | Action |
|---|---|---|
| `api/src/database.ts`, `api/src/migrations/*` (3 files) | `openDatabase`, hand-written runner + SQL migrations | delete |
| `api/src/*/sqlite-*.ts` (6) | flight, booking, audit, outbox repos, transaction runner, health checks | delete |
| Port doc comments: `flight-repository.ts` ("SQLite DatabaseSync"), `health-checks.ts`, `outbox-repository.ts` ("SQLite enforces this implicitly") | describe a world that no longer exists | rewrite storage-neutral |
| `create-flight.ts` ("same SQLite transaction"), `flights-summary-job.ts` ("SQLite still runs COUNT(*)"), `bootstrap/application.ts` ("unchanged from SQLite") | stale description of current behavior | update |
| Postgres files comparing to SQLite (`*.entity.ts`, `postgres-*.ts`, `postgres/migrations/*`) | historical rationale ("unlike SQLite, Day 35…") | keep the reasoning; drop references to deleted file paths (`sqlite-audit-recorder.ts`, `api/src/migrations/migrations.ts`, `SqliteTransactionRunner`) |
| `api/Dockerfile` | `mkdir -p /app/data` (Day 18, for the SQLite volume) | remove, keep `chown` |
| `docker-compose.yml` | top-level `booking_data` volume (unreferenced since Day 40) | remove |
| `.gitignore` | `data/`, `flights.db` | remove; `api/data/` does not exist locally |
| `.dockerignore` | `data` | remove |
| `engines.node >=22` (api, also identity/notifier) | Day 18 reason was `node:sqlite` | keep `>=22`, restate the reason (Node 20 is EOL; `--env-file-if-exists` used by every `npm run` script needs Node 22 — verify against the Node changelog before writing it down) |
| README (≈15 mentions), `docs/architecture-overview.md`, ADR-001/004 wording | describe SQLite as current | README/overview → Postgres; ADRs are historical records, so add a dated note instead of rewriting them |
| `.env.example` | `DATABASE_PATH` | already removed on Day 40 — nothing to do |
| `docs/migration-plan-postgres.md` §6 | rollback = one `git revert` | add the "from Day 41" note |

Decisions on the Step 1 table (user, 2026-10-04): add a Postgres health-check
integration test (no silent loss); delete isolation A/B (c) and the
audit-failure rollback HTTP test (b); ADR-001/004 get a dated note, not a rewrite.

## Step 2 — In-memory fakes (`api/tests/fakes/in-memory.ts`)

```text
One file, factory functions, no classes. Modeled on the Postgres adapters'
business-visible outcomes, not on the deleted SQLite ones:
  FlightRepository: duplicate on PK id OR (flightNumber, departureAt)
    compared as instants (TIMESTAMPTZ), not strings; findPage ordered by
    departureAt then id (same tie-breaker as Postgres); dates normalized to
    toISOString() like the adapter's mapFlight().
  BookingRepository: shares the flight store (seat counts); 3 reserveSeat
    and 3 cancel outcomes; create() throws on unknown flight / duplicate id
    (Postgres FK / PK violations are errors, not outcomes); releaseSeat on
    an unknown flight is a silent no-op (UPDATE matching zero rows).
  AuditRecorder / OutboxRepository: expose records / entries as copies.
  HealthChecks: fixed status.
Every read returns a structuredClone — a test mutating a returned object
  must not change what is "stored".

TransactionRunner: runs the operation, no rollback. Rollback is database
  semantics, not business logic — it can only meaningfully fail against a
  real database, and it is already proven in postgres-transaction-runner
  and create-flight.postgres ("mid-transaction failure"). Simulating it in
  a fake would be a second, untested implementation of a transaction.
Considered and skipped: making the audit/outbox fakes throw when called
  outside run() (the Postgres adapters do). Not needed for any current
  use-case test; noted as a possible addition if a use case ever regresses
  on it.
```

## Step 3 — BookingRepository contract test

```text
tests/contracts/booking-repository.contract.ts (not *.test.ts — a library
  that registers tests only when a runner calls it). 7 sequential cases:
  reserve-until-sold-out, unknown flight -> flight-not-found (not
  sold-out), releaseSeat makes a seat reservable again, cancel -> cancelled
  + flightId, second cancel -> already-cancelled, unknown booking ->
  not-found, create with unknown flight rejects (FK).
Seeding split: the contract owns the *shape* of the data (makeFlight /
  makeBooking); each implementation only supplies insertFlight(flight) —
  how it gets into storage. Seat counts are asserted through reserveSeat,
  so the contract never needs a storage-specific read.
Runners: tests/booking-repository.contract.test.ts (in-memory, unit tier)
  and tests/integration/booking-repository.contract.integration.test.ts
  (Postgres, TRUNCATE per test like its neighbours).
Concurrency deliberately excluded — a single-threaded fake can't fail it;
  postgres-booking-race stays the only place OCC is proven.
Proof the contract bites: changed the fake so an unknown flight returned
  sold-out -> "reserveSeat on an unknown flight returns flight-not-found"
  failed (6/7), reverted -> 7/7.
FlightRepository contract: not today (limitation) — its fake's duplicate
  rule (instant comparison) is the most likely place to drift, so it is
  the first candidate if a second contract is added.

Expected counts now: unit 186 - 34 + 7 = 159 after Step 4;
  integration 33 + 7 (contract) + 2 (Postgres health checks) = 42.
```

## Step 4 — Group (a) moved to fakes, groups (b)/(c) deleted

```text
Converted (wiring only, assertions unchanged unless they read SQLite):
  create-booking, cancel-booking: createTestRuntime() builds fakes; their
    local capturing audit/outbox helpers kept as-is (not SQLite, smaller
    diff to review).
  bookings.api, health.api, request-observability, verify-jwt: SQLite
    factories swapped for fakes, t.after(database.close) removed.
  flights.api: createAppWithRepository(flightRepository, { flights,
    auditRecorder, healthChecks? }); createTestContext() returns
    { app, audit, repository }. The 5 audit tests now assert on
    audit.records instead of SELECTs on audit_logs (the "records an audit
    log" test checks the flight via repository.findById and the full
    record: action, actor, target, requestId, metadata).
Deleted test files: sqlite-{booking,flight,outbox}-repository,
  transaction-runner, audit-recorder, migration-runner, health-checks.
Deleted tests inside kept files: create-booking "concurrent bookings…",
  cancel-booking "concurrent double-cancel…" (race now guarded only by
  postgres-booking-race Tests A/B — on a fake they could not fail),
  flights.api isolation A/B, the two database-file tests, and the
  audit-failure rollback test.
Added: tests/integration/postgres-health-checks.integration.test.ts (2) —
  read-only (no TRUNCATE), so it was run against the live dev stack: 2/2.

npm test (api): 159/159 — exactly 186 - 34 + 7 (contract), matching the
  Step 1 prediction. No unit test file opens a database connection
  (only transaction-context.test.ts imports typeorm, for types and a cast
  fake DataSource).
```

## Step 5 — SQLite removed

```text
Deleted (10 src files): database.ts, migrations/{migration,migration-runner,
  migrations}.ts (+ the now-empty folder), sqlite-{audit-recorder,
  booking-repository,flight-repository,health-checks,outbox-repository,
  transaction-runner}.ts.
Comments describing SQLite as current rewritten storage-neutral: the
  FlightRepository / HealthChecks / OutboxRepository ports, create-flight,
  flights-summary-job, bootstrap. Postgres files keep their "unlike SQLite
  (Day 35)…" rationale but no longer name deleted files/symbols.
Infra: Dockerfile drops `mkdir -p /app/data` (keeps chown); compose drops
  the unreferenced booking_data volume; .gitignore drops data/ and
  flights.db; .dockerignore drops data.
engines.node >=22 kept, reason restated in README: node:sqlite is gone,
  but Node 20 is EOL (2026-04-30) and 22 is the oldest maintained LTS,
  matching node:22-slim. (Did not claim --env-file-if-exists needs 22 —
  could not verify it against the changelog offline.)
Docs: README (config table now lists the Postgres vars and drops
  DATABASE_PATH, migrations section describes TypeORM, docker run example,
  persistence rows, flow diagram, limitations); architecture-overview
  storage lines; ADR-001/004 got a dated "Update (Day 41)" note pointing at
  ADR-006 instead of being rewritten; migration-plan §6 got the
  point-of-no-return note.
Remaining "sqlite" mentions are historical rationale only (Postgres
  migrations/entities, a few integration-test headers).

typecheck (all workspaces) + typecheck:test clean; api build ok;
  npm test 159/159.
```

## Step 6 — Reconciliation and records

```text
Unit test count: 186 (after Step 0) - 34 (Step 1 groups b/c) + 7 (contract,
  in-memory) = 159 — matches `npm test` exactly; no silent loss.
Integration test count expected: 33 + 7 (contract, Postgres) + 2 (Postgres
  health checks) = 42.
ADR-005 (test strategy: fakes for logic, Postgres for database semantics,
  contract tests between them) and ADR-006 (SQLite -> Postgres, as a
  decision record; migration-plan-postgres.md stays the detailed doc).
  ADR-001/004 carry a dated note instead of a rewrite.
```

## Not today

```text
FlightRepository contract test — its fake's instant-based duplicate rule
  is the likeliest drift; first candidate for the next contract.
Audit/outbox fakes don't enforce "must be called inside run()" like the
  Postgres adapters do.
Integration tests TRUNCATE the shared dev booking_db — a separate test
  database would stop them from wiping dev data.
/ready doesn't include RabbitMQ; broker outages show up only as
  outbox_publish_failed logs + unpublished rows.
Two recovery styles coexist: api publisher reconnects in-process,
  flight-notifier relies on crash + restart policy.
README "Current limitations" still has pre-Day-36 lines unrelated to SQLite
  (e.g. "Use case / repository still synchronous") — not touched today.
```

## DAY 41 SUMMARY

```text
Closed the last Day 40 operational gap (publisher reconnect) and finished
the strangler fig: SQLite is gone from api's code, image, compose and
ignore files. Instead of keeping SQLite alive as a test double, tests are
split by what they can prove — fakes for business logic and HTTP mapping,
real Postgres for transactions, constraints and concurrency — with a
contract test keeping the BookingRepository fake honest. Every removed test
was classified up front, and the final count matched the prediction exactly.
```
