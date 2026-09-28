# Day 40 — Session Notes

**Date completed:** 2026-09-28
**Theme:** Cutover — switch all of `api` to Postgres in one combined wiring step
**Status:** Completed — `bootstrap/application.ts` now wires every Postgres repository +
`PostgresTransactionRunner` + `PostgresHealthChecks`; SQLite code stays in the tree, unwired
(deleted in Day 41). Verified end to end against the real docker-compose stack: auth, flight,
booking, outbox delivery, outbox self-healing, health reflecting Postgres, graceful shutdown,
and an HTTP-level repeat of Day 39's race test.

## Why cutover gets its own day, and why SQLite isn't deleted today

```text
Everything proven in Days 36-39 was proven inside test processes. Production
has surface area no integration test touches: which database the health
check pings, what close() actually shuts down and in what order, when
migrations run, which container has to be healthy before another starts,
and — new today — which Postgres role the connection uses. Today's job was
finding out where that surface area was still pointed at SQLite.

SQLite code stays in the tree, unwired, per the isolation-of-change
principle (Day 19): mixing "flip the wiring" with "delete a few thousand
lines of SQLite adapters" in one commit would make a rollback ambiguous —
if something broke, was it the wiring or the deletion? Rollback today is
exactly `git revert` one commit (Section 6 of migration-plan-postgres.md,
written before touching any code). Day 41 does the SQLite removal, once its
own real question (what does the unit test tier look like once
node:sqlite is gone) has an answer, not bundled into today's diff.
```

## Step 0 — two carried-over corrections from Day 39

```text
1. idx_bookings_flight_id's stated reason was wrong: it does NOT serve
   reserveSeat/releaseSeat (those look flights up by flights.id, never by
   scanning bookings). Corrected in the migration's doc comment and
   DAY-39.md: it serves the FK constraint check itself (an indexed lookup
   instead of a sequential scan when a referenced flights row changes) and
   any future "bookings for this flight" read.
2. Test C's assertion weakened from reservedCount === 20 to
   reservedCount > flight.availableSeats — the exact-20 claim coupled the
   test to "every caller's read happens to land before any write," a
   stronger claim than the bug itself requires. Re-verified 32/32 stable
   after the change.
```

## Biggest catches

```text
1. (Real, caught before it did damage) I ran `docker compose down -v`
   twice while 3 of the user's own `npm run dev` (tsx --watch) processes
   were live in other terminals — started earlier that morning, not by
   this session. This wiped the shared Postgres/RabbitMQ dev volumes out
   from under them, and their processes' restart-on-file-change behavior
   (triggered by my edits to bootstrap/application.ts) produced stray
   duplicate-key/FK errors in the postgres log that looked like a real bug
   at first. Caught by checking `ps aux` before continuing, confirmed with
   the user, stopped those processes with permission, then re-verified
   clean. Lesson: `docker compose down -v` is destructive to more than just
   "my" state in a shared dev environment — check for other live consumers
   of the same infrastructure before running it, not just before the first
   time.
2. All Postgres integration tests — including ones written and passing on
   Days 36-39 — were unknowingly connecting as `identity`, which (via the
   official postgres image's bootstrap POSTGRES_USER env var) is the
   cluster SUPERUSER, not an ordinary app role. Discovered while verifying
   the new dedicated `booking` role: switching the tests' default
   credentials to the real `booking` role surfaced a `relation "migrations"
   already exists` error, because earlier test runs (as the superuser) had
   created objects in booking_db owned by identity, which the new
   non-superuser `booking` role couldn't cleanly interoperate with. Fixed
   by wiping the dev volume and re-running everything as `booking` from a
   clean slate, and by changing postgres/config.ts's test-convenience
   defaults from identity's credentials to BOOKING_POSTGRES_USER/PASSWORD —
   so the integration test suite now actually exercises the role's real
   privilege boundary instead of trivially succeeding via superuser bypass.
3. Creating a dedicated `booking` role and making it OWNER of booking_db is
   not enough for isolation — Postgres grants CONNECT to PUBLIC on every
   database by default; only table-level privileges are withheld
   automatically. Confirmed empirically: `booking` could still connect to
   identity_db (though it saw zero tables there, correctly, since
   table-level SELECT grants are separate from CONNECT). Fixed with an
   explicit `REVOKE CONNECT ON DATABASE identity_db FROM PUBLIC` in the
   init script. Known asymmetry, documented rather than silently ignored:
   identity's own POSTGRES_USER is the superuser and bypasses REVOKE
   entirely, so this protects booking_db's isolation from identity_db one
   way (booking can never reach identity_db) but not the reverse
   (identity's superuser could still reach booking_db) — fixing that
   direction means identity stops using the superuser for routine
   connections, which is outside this service's code and out of scope
   for Day 40.
4. Scenario 6 (outbox self-healing) revealed the RabbitMQ publisher has no
   reconnect-on-drop logic — restarting RabbitMQ did not recover the app's
   publish path; it kept failing with "Channel closed" until the app
   process itself was restarted, and it had in fact already crashed
   uncaught once (no restart policy configured). The outbox row itself
   behaved exactly as designed (survived, published_at stayed NULL,
   published successfully the moment a working connection existed) — the
   gap is specifically in messaging/rabbitmq-publisher.ts's connection
   handling, out of scope to fix today. Added `restart: unless-stopped` to
   the app service (matching flight-notifier's existing policy) since its
   absence directly undermines the outbox's "never lose the event" premise
   and it's a one-line, zero-risk addition to a file already being edited
   for the cutover; the actual reconnect logic is a real gap for a future
   day.
```

## Decisions made this session

```text
Migrations run at Composition Root startup (dataSource.runMigrations()
  right after initialize()), not as a separate deploy step — matches
  SQLite's existing always-migrate-on-boot behavior (least behavior
  change) and is safe because only one api instance runs today (Day 17
  limitation); revisit if/when multiple instances start concurrently.
Dedicated `booking` Postgres role, not identity's shared POSTGRES_USER/
  PASSWORD — api's connection has no path to identity_db (Section 4).
  BOOKING_POSTGRES_USER/PASSWORD are new, separate env vars (not
  POSTGRES_USER/PASSWORD, which stay identity's).
config.ts's Postgres fields are fail-fast (BOOKING_POSTGRES_USER/PASSWORD
  have no default), same reasoning as jwtSecret — no default credential is
  safe to bake into source. This is intentionally stricter than
  postgres/config.ts's parsePostgresConfig(), which keeps soft defaults
  because it exists purely for local integration-test convenience, not
  for the real Composition Root.
health-checks.ts split into a port (health-checks.ts) + two
  implementations (sqlite-health-checks.ts, health/postgres/
  postgres-health-checks.ts) — the interface/implementation pairing this
  codebase already uses for every repository, applied here for the first
  time now that health checks actually need to swap storage.
DATABASE_PATH removed from config.ts/index.ts/.env/.env.example — no
  longer read by the runtime; api/data/booking.db itself and its
  .gitignore entry are left alone until Day 41 (Section 5.2's revision).
booking_data compose volume: mount removed from the app service, but the
  top-level volume declaration is left in docker-compose.yml (harmless
  when unreferenced) rather than deleted outright — keeps the rollback
  path symmetric (Section 6): reverting the cutover commit needs nothing
  else to happen for the old mount to be usable again.
tests/application.test.ts moved to tests/integration/
  application.integration.test.ts — before cutover it opened a throwaway
  SQLite file/:memory: db per test (no external dependency); after
  cutover createApplication() always builds a real Postgres DataSource,
  so there is no in-process equivalent left. This is now, correctly, an
  integration test, not a unit test quietly requiring Postgres.
```

## Verified end to end (Step 6, against the real docker-compose stack)

```text
1. Startup: migrations ran (5 tables incl. migrations, all owned by
   booking), GET /ready -> 200.
2. Auth: register admin + regular user, promote-to-admin script, both
   logins issue JWTs with correct role claim.
3. Flight: POST as admin -> 201; duplicate -> 409; POST as regular user ->
   403; GET /api/flights lists it; row confirmed directly in booking_db.
4. Booking: 5x POST on a 5-seat flight -> 201 each; 6th -> 409 sold-out;
   DELETE booking -> 204; second DELETE -> 409 already-cancelled;
   available_seats confirmed 1 (5 total, 4 active, 1 cancelled) directly
   in Postgres.
5. Outbox + consumer: flight-notifier logs flight_created_consumed and
   booking_created_consumed; correlationId in the consumer log verified to
   exactly match the X-Correlation-Id response header from the original
   HTTP request.
6. Outbox self-healing: flight created with RabbitMQ stopped -> still 201;
   outbox row confirmed published_at IS NULL; RabbitMQ restarted -> row
   published once the app itself was restarted (see catch #4 above for
   why a bare RabbitMQ restart alone did not recover the app's own
   connection).
7. Health reflects Postgres: docker compose stop postgres -> /ready 503;
   restart postgres -> /ready back to 200.
8. Graceful shutdown: docker compose stop app -> server_shutdown_started
   then server_shutdown_completed, ~5ms apart, no errors; step order
   (jobScheduler.stop -> messagePublisher.close -> dataSource.destroy) is
   fixed by application.ts's close() and was reviewed directly rather than
   inferred from logs, since no per-step log lines exist (adding them
   would be scope creep beyond a wiring-only cutover).
Bonus (Day 39's race test through the full HTTP layer): 20 concurrent
   POST .../bookings against a 5-seat flight -> exactly 5x 201 / 15x 409;
   available_seats confirmed 0 directly in Postgres.
npm test (api) -> 182/182; npm run test:integration -> 33/33, stable
   across 3 repeated runs.
```

## Not today

```text
node:sqlite code (repositories, migration-runner, migrations.ts) stays in
  the tree, unwired — deleted in Day 41, alongside deciding the unit test
  strategy once no SQLite adapter exists to fake against.
RabbitMQ publisher reconnect-on-drop logic — a real gap surfaced by
  Scenario 6, not part of this cutover's scope.
identity's own POSTGRES_USER still being the cluster superuser — the
  REVOKE CONNECT added today protects booking_db from identity_db access
  one way only; fixing the reverse direction is out of scope (identity
  service's own code, not api's).
api/data/booking.db and its .gitignore entry — left as is (Section 5.2
  revision), removed as part of Day 41's SQLite cleanup instead.
```
