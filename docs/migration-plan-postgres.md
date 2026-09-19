# Migration Plan — `api`: SQLite → Postgres/TypeORM

Day 35. Planning only — no application code changes today. Written before any
migration code exists, so the actual Day 36+ work can follow a known order
instead of discovering scope mid-migration.

Strategy already decided: **Strangler Fig**, in increasing risk order
(see Section 2). No dual-write between SQLite and Postgres — see Section 3
for why. **Revised in Section 5:** the four tables are not independently
cuttable — `create-flight.ts` and `create-booking.ts`/`cancel-booking.ts`
wrap multiple repositories in one shared `TransactionRunner.run()` today,
so "one repository at a time, cut to production independently" as
originally framed would silently break Day 14's atomicity guarantee
mid-migration. Section 5 splits "write and test the new repository" (still
one at a time, in this order) from "cut production over to it" (one
combined step, once all four are ready).

## 1. Dependency inventory

Grepped, not recalled from memory (`grep -rln "node:sqlite" api/src` /
`grep -rln "DatabaseSync" api/src`, plus the same two against `api/tests`).
Actual count: **9 files in `api/src`**, not the ~20 guessed beforehand — the
Repository pattern from Day 6 is doing its job, isolating the infra
dependency to one file per feature instead of letting it leak into use
cases or routes.

One grep hit that is **not** a real dependency: `api/src/flights/flight-repository.ts`
mentions `DatabaseSync` only in a doc comment describing what the interface
must *not* leak — worth noting because a naive count-the-grep-hits approach
would over-count by one.

| File | Role | Migration note |
|---|---|---|
| `api/src/database.ts` | `openDatabase()` — the single `DatabaseSync` connection factory | Becomes a TypeORM `DataSource` factory; this is the one place `bootstrap/application.ts` calls, so the swap point is already centralized (Day 16 Composition Root paying off here) |
| `api/src/migrations/migration.ts` | `Migration` port: `{ id, up(database: DatabaseSync): void }` | Port shape doesn't survive as-is — TypeORM owns its own migration format/runner; this port and `migration-runner.ts` are likely retired, not migrated |
| `api/src/migrations/migration-runner.ts` | Applies pending migrations via `schema_migrations` table, raw `exec`/`prepare`, `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` | Same as above — TypeORM's migration runner replaces this outright |
| `api/src/migrations/migrations.ts` | 5 migrations, raw SQL DDL: `STRICT` tables, `CHECK` constraints, a **partial index** (`WHERE published_at IS NULL`), one `ALTER TABLE ... ADD COLUMN` | Every table's DDL needs rewriting as TypeORM migrations/entities — see Section 2 for the specific syntax deltas |
| `api/src/flights/sqlite-flight-repository.ts` | `FlightRepository` impl — CRUD, pagination query | Lowest risk: no conditional-write logic, no concurrency concern |
| `api/src/audit/sqlite-audit-recorder.ts` | `AuditRecorder` impl — insert-only | Low risk: append-only, no read-then-write |
| `api/src/outbox/sqlite-outbox-repository.ts` | `OutboxRepository` impl — enqueue + relay poll, relies on the partial index to find unpublished rows cheaply | Medium: partial index syntax must be confirmed on Postgres (it's supported, but declared differently via TypeORM) |
| `api/src/bookings/sqlite-booking-repository.ts` | `BookingRepository` impl — `reserveSeat`/`cancel`, both conditional `UPDATE ... WHERE <guard>` for Optimistic Concurrency Control (Day 26/28) | **Highest risk** — behavior under concurrent writes must be re-proven, not assumed; see Section 2 and the Day 26 race-condition test in Section 4 |
| `api/src/transactions/sqlite-transaction-runner.ts` | `TransactionRunner` impl — wraps `BEGIN`/`COMMIT`/`ROLLBACK` around a repository call so e.g. flight+audit commit atomically | Interface (`TransactionRunner` port) stays; implementation is swapped for one built on TypeORM's `QueryRunner`/`EntityManager.transaction()` — same port/adapter move already done once for the message publisher at Day 20 |
| `api/src/health/health-checks.ts` | Readiness check runs a trivial query directly against `DatabaseSync` to prove the DB connection is alive | Low risk: swap the raw query for an equivalent TypeORM/`pg` ping |

Test suite (`api/tests`, separate from `api/src`): **3 files** open a real
`DatabaseSync` directly instead of only going through fakes —
`migration-runner.test.ts`, `flights.api.test.ts`, `bookings.api.test.ts`.
These construct a throwaway SQLite database per test run today; each will
need an equivalent throwaway-Postgres (or a shared test container) story
before its repository is migrated, not after.

## 2. SQLite vs Postgres behavior deltas

Six concrete deltas, ranked by how much they can silently change behavior
rather than just change syntax.

### 2.1 Conditional `UPDATE` affected-row-count — highest risk, `BookingRepository` only

`sqlite-booking-repository.ts` reads `result.changes` (a `number | bigint`
from `node:sqlite`'s statement result) as the *only* signal that the OCC
guard passed:

```ts
const decrementSeat = database.prepare(`
  UPDATE flights SET available_seats = available_seats - 1
  WHERE id = ? AND available_seats > 0
`);
const result = decrementSeat.run(flightId);
if (readChangeCount(result.changes) === 1) { /* reserved */ }
```

`cancel()` does the identical thing against `bookings.status = 'active'`.
Both `reserveSeat` and `cancel` treat "0 rows changed" as ambiguous and run
a second `SELECT` to tell "not found" apart from "guard failed" — that
two-query fallback shape has to survive the migration unchanged; only the
row-count source changes underneath it.

Postgres equivalent depends on the client: raw `pg` gives `rowCount` on
the query result; TypeORM's `Repository.update()` / `QueryBuilder.update()`
returns `UpdateResult.affected`. **This needs a throwaway spike before
`BookingRepository` is migrated (Day 38+), not an assumption** — confirm
`affected` is reliably populated for a `pg`-backed conditional `UPDATE`
with no `RETURNING` clause, since some TypeORM/driver combinations only
populate it when a `RETURNING` clause is present.

### 2.2 `BEGIN IMMEDIATE` has no Postgres equivalent — because the problem it solves doesn't exist there

`migration-runner.ts` and (implicitly) every write path use SQLite's
single-writer model, where `BEGIN IMMEDIATE` grabs the write lock eagerly
to avoid a late `SQLITE_BUSY` failure. Postgres uses MVCC with row-level
locking under `READ COMMITTED` by default — there is nothing to port here,
because the OCC guard is already enforced by the conditional `UPDATE`
itself (2.1), not by upfront locking. Don't translate `BEGIN IMMEDIATE` to
a Postgres `LOCK TABLE` or `SELECT ... FOR UPDATE` — that would be solving
a problem SQLite has and Postgres doesn't.

### 2.3 Foreign key on `bookings.flight_id` is currently unenforced

`migrations.ts` declares `flight_id TEXT NOT NULL REFERENCES flights(id)`,
but `database.ts` never runs `PRAGMA foreign_keys = ON` — SQLite disables
FK enforcement by default unless that pragma is set per-connection, and
this codebase doesn't set it. So today, nothing actually stops a
`bookings` row from referencing a nonexistent `flights.id`; the constraint
is documentation, not enforcement. Postgres enforces foreign keys
unconditionally. This is a **behavior change, not just a syntax port** —
if any test fixture or manual Postman data currently relies on the
unenforced FK (an orphaned booking row, a flight deleted after booking),
migrating `BookingRepository` will start rejecting inserts that silently
succeeded before. Worth a quick check for orphaned rows before that step.

### 2.4 `TEXT` timestamps vs `TIMESTAMPTZ` — and a hidden ordering assumption

Dates have been `TEXT` (ISO-8601 strings) since Day 1. `migrations.ts` has
`CHECK (arrival_at > departure_at)` — a **string** comparison, which only
matches chronological order because every timestamp is written as UTC with
a consistent `Z` suffix and zero-padded fields. Postgres's `TIMESTAMPTZ`
would make that comparison a real chronological one instead of relying on
string-format discipline holding forever.

Decision to make (not made yet): keep `TEXT` to minimize the diff per
Strangler Fig step, or switch to `TIMESTAMPTZ` now while each repository
is already being touched. Leaning `TIMESTAMPTZ` for `FlightRepository`
(step 1 of the Strangler Fig order) specifically *because* it's the
lowest-risk repository to absorb a type change in, and it removes the
string-ordering assumption at the one place (`arrival_at > departure_at`)
that depends on it. Repositories with no such comparison (`AuditRecorder`,
`OutboxRepository`) have less reason to change and can keep `TEXT` if that
reduces churn — final call written into Section 5's per-step criteria.

### 2.5 `STRICT` table mode has no Postgres equivalent — and needs none

SQLite's `STRICT` keyword (used on every table) opts into type-checked
columns instead of SQLite's default dynamic typing. Postgres columns are
always statically typed — there's nothing to port; dropping `STRICT` from
the DDL is not a loss of safety, it's Postgres's default behavior.

### 2.6 Partial index — fully supported, syntax only

`idx_outbox_unpublished ON outbox (published_at) WHERE published_at IS NULL`
has a direct Postgres equivalent (`CREATE INDEX ... WHERE published_at IS
NULL` is valid Postgres DDL as-is). Via TypeORM it's declared through the
migration's raw SQL in `up()` (same as today) or `@Index(['publishedAt'],
{ where: '"publishedAt" IS NULL' })` on the entity — no semantic change,
lowest-risk item on this list.

## 3. Data export/import plan

**Decision: no export/import script. Start Postgres empty, run migrations
from scratch, discard `api/data/booking.db`.**

Why this is the right call *here*: `api/data/booking.db` is gitignored
(`data/` in `.gitignore`) — it has never been anything but a local dev
artifact regenerated by running migrations, seeded by whatever manual
Postman testing happened that session. There are no real customers, no
real bookings, nothing with a cost to losing it. Writing an export/import
script for data that has zero value the moment it's regenerated would be
solving a problem that doesn't exist — the same anti-over-engineering
principle behind not dual-writing (see the ADR-001 outbox reasoning) and
behind not adding a roles/permissions table before Day 34 needed one.

This is also why Strangler Fig order (Section 1: Flight → Outbox → Audit →
Booking) can afford to be "delete and recreate" per table rather than a
careful phased backfill — there's no live traffic and no data at risk
during the transition window.

**What would be different if this were real production data** (a
deliberate contrast, not part of the actual plan): with paying customers
and existing bookings, "start empty" is not an option — a real migration
would need (a) a one-time bulk export of every table to CSV/`pg_dump`-style
dump, (b) a transform step for every Section 2 delta (rewrite timestamps,
re-validate the previously-unenforced `bookings.flight_id` FK and decide
what to do with any orphaned rows it finds), (c) a cutover window or
dual-write period with reconciliation, and (d) a rollback plan if the
imported data fails validation on the Postgres side. None of that is
needed today — the gap between "learning project" and "system with a real
migration" is exactly this section.

## 4. Risk list + mitigations

Each risk below is specific to something found in Section 1/2, not a
generic "migrations are risky" statement.

```
Risk: UpdateResult.affected (TypeORM) or rowCount (raw pg) may not be
      populated the same way node:sqlite's result.changes is for a
      conditional UPDATE with no RETURNING clause — reserveSeat/cancel in
      sqlite-booking-repository.ts depend on this being an exact,
      trustworthy integer.
Mitigation: Before migrating BookingRepository (last Strangler Fig step),
      write a 10-line throwaway script against a real Postgres instance:
      run the exact `UPDATE flights SET available_seats = available_seats
      - 1 WHERE id = ? AND available_seats > 0` via whichever client is
      chosen, print the affected-row count for a hit and a miss, confirm
      both match node:sqlite's behavior before writing the real
      repository.
```

```
Risk: SQLite's single-writer model serializes all writes, so the Day 26
      Promise.all race-condition test may be passing partly *because*
      SQLite never truly runs two writes concurrently — a real Postgres
      connection pool can. A bug only reachable under genuine concurrent
      writes could be invisible on SQLite and only surface on Postgres.
Mitigation: Rerun the exact Day 26/28 Promise.all race-condition tests
      (last-seat overbooking, double-cancel) against a real Postgres
      connection pool (size > 1) immediately after BookingRepository
      migrates — not against a fake, and not against SQLite.
```

```
Risk: bookings.flight_id's foreign key is declared but currently
      unenforced (Section 2.3, no PRAGMA foreign_keys = ON). Postgres
      enforces it unconditionally. Any orphaned booking row in dev data,
      or any code path that could theoretically insert a booking before
      its flight is committed, starts failing only after migration.
Mitigation: Since Section 3 already discards dev data, the "orphaned
      row" half of this risk is moot by construction. The remaining half
      — insert order — needs one explicit check when BookingRepository
      migrates: confirm booking creation always happens after the
      referenced flight exists in the same transaction/connection, and
      add a test that asserts a clean FK-violation error (not a raw
      Postgres error leaking through http-errors.ts's central handler)
      when it doesn't.
```

```
Risk: During the Strangler Fig window, api needs two migration systems
      running side by side — the existing migration-runner.ts/DatabaseSync
      path for tables not yet migrated, and TypeORM's own migration
      runner for tables that are. migration.ts's Migration port
      (up(database: DatabaseSync): void) has no Postgres equivalent and
      doesn't survive this transition (Section 1).
Mitigation: bootstrap/application.ts explicitly wires both connections
      side by side for the duration of the migration (already the one
      place infra is constructed, per this repo's Composition Root rule
      — no new wiring pattern needed). Section 5 states exactly which
      step removes the SQLite connection and migration-runner.ts/
      migration.ts entirely (the Booking step, since it's last).
```

```
Risk: Zero tests in this repo exercise a real Postgres today — even
      services/identity, which already runs on Postgres/TypeORM, tests
      exclusively against hand-written in-memory fakes (checked: both
      login.test.ts and register.test.ts). DB-level guarantees this
      project has relied on so far (CHECK constraints, the now-enforced
      FK from the risk above, the partial index actually being used by
      the query planner) have never been verified against a live
      database anywhere in this codebase.
Mitigation: Migrating api's repositories is the first time this project
      needs an integration-test tier that hits real Postgres, not just
      the unit-test-against-fakes tier it has used since Day 1. Decide
      and document this as its own small piece of Day 36 setup (reuse
      the docker-compose Postgres service already running for identity;
      likely a per-test-file transaction-rollback or truncate strategy
      for isolation) before the first repository migrates, not
      discovered ad hoc mid-migration.
```

```
Risk: api/tests currently needs zero external services to run (node:sqlite
      is in-process); 3 files (migration-runner.test.ts, flights.api.test.ts,
      bookings.api.test.ts) open a real DatabaseSync directly. Once any
      repository migrates, running api's test suite starts requiring a
      reachable Postgres instance — a new local/CI dependency that didn't
      exist before.
Mitigation: Confirm CI and local dev both already start Postgres before
      running api tests (docker-compose already has a postgres service for
      identity) before the first repository migrates — this is
      infrastructure that needs to exist on day 1 of execution, not
      something to discover when a test suddenly fails on a clean
      checkout.
```

## 5. Completion criteria per Strangler Fig step

### 5.0 Why "cut over independently per table" doesn't hold here

Checked directly in code, not assumed:

- `create-flight.ts` calls `transactionRunner.run(() => { flightRepository...,
  auditRecorder.record(...), outboxRepository.enqueue(...) })` — flights,
  audit_logs, and outbox share one transaction.
- `create-booking.ts` and `cancel-booking.ts` both call
  `transactionRunner.run(...)` around `bookingRepository` (which itself
  writes to both `flights.available_seats` and `bookings`) plus
  `outboxRepository.enqueue(...)` — flights, bookings, and outbox share
  one transaction there too.

Union of both: **flights, audit_logs, outbox, and bookings are all
transactionally coupled through the one shared `TransactionRunner`.**
There is no table that can move to Postgres alone while the others stay on
SQLite without either (a) breaking atomicity for one of these two use
cases during the transition window, or (b) quietly reintroducing the
dual-write problem Day 24's Outbox pattern exists to avoid — a partial
commit split across two databases is exactly that failure mode.

Given Section 3 (no real traffic, nothing at risk today), option (a) for a
short, deliberate window is acceptable — but it must be a *chosen, stated*
trade-off in this document, not something Day 36-39 discovers by accident
partway through. So: development stays incremental and ordered by risk
(write + unit-test one repository at a time, cheapest to review that way);
the **production cutover** — repointing `bootstrap/application.ts` from
the SQLite `TransactionRunner`/repositories to the Postgres ones — happens
as **one atomic step for all four tables together**, only once all four
are individually dev-complete below.

*(Aside, out of scope for Day 35: the real fix for “audit must be
atomic with its subject” is arguably to make audit eventually-consistent
via the outbox, the same way cross-service notification already is —
but redesigning Day 14's transaction boundary is a different, bigger
decision than migrating its storage, and isn't needed just to change
databases.)*

### 5.1 Per-repository dev-complete criteria (build in this order; ship together)

**`FlightRepository` (write first — lowest risk, absorbs the `TIMESTAMPTZ` decision from 2.4):**
- [ ] TypeORM entity/migration creates `flights` with `TIMESTAMPTZ` columns for `departure_at`/`arrival_at` (Section 2.4's decision applied here).
- [ ] `arrival_at > departure_at` enforced as a real chronological `CHECK`, not a string comparison.
- [ ] All existing `FlightRepository` consumers (`create-flight.ts`, `list-flights.ts`, etc.) compile and pass with zero changes — proves the port/adapter boundary held.
- [ ] Existing flight repository tests pass against a real Postgres instance (Section 4's testing-infra risk resolved *here*, first, since every later step depends on it existing).
- [ ] No `node:sqlite` / `DatabaseSync` import remains in the new file.

**`OutboxRepository` (write second):**
- [ ] Partial index (`WHERE published_at IS NULL`) confirmed via `EXPLAIN` to actually be used by the query planner for the relay's poll query — not just assumed from matching syntax (Section 2.6).
- [ ] Outbox relay job (`JobScheduler`) tests pass unchanged against the Postgres-backed repository — proves the port held here too.

**`AuditRecorder` (write third):**
- [ ] Insert-only write path tested against real Postgres.
- [ ] `audit_logs` indexes (`occurred_at`, `target_type`+`target_id`, `request_id`) recreated and confirmed used by the queries that read them.

**`BookingRepository` (write last — highest risk, per Section 2.1/2.2):**
- [ ] The `UpdateResult.affected`/`rowCount` spike from Section 4's first risk is done and confirmed *before* writing this repository, not during.
- [ ] `reserveSeat`/`cancel`'s two-query fallback shape (conditional `UPDATE`, then a `SELECT` only on a miss) is preserved exactly.
- [ ] The Day 26/28 `Promise.all` race-condition tests (last-seat overbooking, double-cancel) pass against a real Postgres connection pool with size > 1 — the actual concern from Section 4's second risk, not just "tests pass."
- [ ] FK-violation path (Section 2.3/4's third risk) has an explicit test: attempting to reference a nonexistent flight fails with a clean mapped error, not a raw driver error leaking past `http-errors.ts`.

### 5.2 Cutover criteria (one combined step, after all four above are checked off)

- [ ] `bootstrap/application.ts` wires a single Postgres `TransactionRunner` and all four Postgres repositories together, replacing the SQLite ones in the same commit — no partial state where some use cases run on SQLite and others on Postgres.
- [ ] Full `api` test suite (unit + the new Postgres-backed tests) passes with `node:sqlite` fully removed from the dependency tree — `migration-runner.ts`, `migration.ts`, and `migrations.ts` deleted, not left dormant.
- [ ] `health-checks.ts` pings the Postgres connection, not `DatabaseSync`.
- [ ] Manual Postman run through the full create-flight → create-booking → cancel-booking → outbox-relay-to-RabbitMQ path confirms identical behavior to pre-migration.
- [ ] `api/data/booking.db` and its gitignore entry are removed — nothing in the codebase still expects a local SQLite file to exist.
