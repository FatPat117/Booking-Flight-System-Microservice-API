# CURRENT PROGRESS

**Last completed day:** Day 40
**Current day:** Day 40 — Cutover: `api` now runs entirely on Postgres
**Status:** Closed — `bootstrap/application.ts` wires every Postgres repository, `PostgresTransactionRunner`, and the new `PostgresHealthChecks`; a dedicated `booking` Postgres role (not identity's) owns `booking_db`. SQLite code stays in the tree, unwired — deleted in Day 41. Verified end to end against the real docker-compose stack: auth, flight, booking, outbox delivery + self-healing, health reflecting Postgres, graceful shutdown, and an HTTP-level repeat of Day 39's race test (20 concurrent bookings on a 5-seat flight -> exactly 5x 201/15x 409).

## Day 40 delivered

```text
2 corrections carried over from Day 39 review: idx_bookings_flight_id's
  real purpose (FK constraint check, not reserveSeat/releaseSeat), Test C's
  assertion weakened to the minimum sufficient claim (reservedCount >
  availableSeats, not === 20)
Rollback plan written before touching any code
  (docs/migration-plan-postgres.md Section 6): revert is exactly one
  `git revert`, Postgres data does not travel back to SQLite, a
  revert-vs-fix-forward signal table
Dedicated `booking` Postgres role (docker/postgres-init), REVOKE CONNECT
  on identity_db from PUBLIC — api's connection has no path to identity_db
config.ts: fail-fast BOOKING_POSTGRES_USER/PASSWORD (same reasoning as
  jwtSecret); DATABASE_PATH removed
health-checks.ts split into port + SqliteHealthChecks + PostgresHealthChecks
  (this codebase's existing interface/implementation pattern, applied to
  health checks for the first time)
bootstrap/application.ts rewired to Postgres end to end; use cases and
  OutboxRelay untouched (proves the port/adapter boundary held)
tests/application.test.ts moved to tests/integration/ (createApplication()
  now always requires real Postgres, no in-process equivalent left)
docker-compose.yml: app depends_on postgres (service_healthy), POSTGRES_HOST
  =postgres, BOOKING_POSTGRES_USER/PASSWORD, restart: unless-stopped added
```

## Biggest catches

```text
1. Ran `docker compose down -v` twice while 3 of the user's own `npm run
   dev` processes were live in other terminals (started earlier that
   morning) — wiped shared dev volumes out from under them. Caught via
   `ps aux`, confirmed with the user, stopped those processes with
   permission, re-verified clean. Lesson: check for other live consumers
   of shared dev infrastructure before `down -v`, every time, not just
   the first time.
2. Every Postgres integration test (Days 36-39 included) was unknowingly
   connecting as `identity`, which is the Postgres cluster SUPERUSER (via
   the official image's bootstrap POSTGRES_USER), not an ordinary role.
   Switching to the real `booking` role surfaced a "migrations already
   exists" error from stale identity-owned objects in booking_db from
   earlier runs. Fixed by wiping the dev volume and re-running everything
   as `booking` from empty, and by changing postgres/config.ts's
   test-convenience defaults to BOOKING_POSTGRES_USER/PASSWORD so the
   suite now actually exercises the new role's privilege boundary.
3. Database ownership alone doesn't isolate databases — Postgres grants
   CONNECT to PUBLIC on every database by default. `booking` could still
   connect to identity_db (though it saw zero tables there). Fixed with an
   explicit REVOKE CONNECT. Known, documented asymmetry: identity's own
   POSTGRES_USER is the superuser and bypasses REVOKE, so this protects
   one direction only.
4. Scenario 6 (outbox self-healing) revealed the RabbitMQ publisher has no
   reconnect-on-drop logic, and the app had no restart policy — a restarted
   RabbitMQ did not recover the app's publish path until the app itself
   restarted. The outbox row itself behaved exactly as designed (survived,
   published once a working connection existed). Added
   `restart: unless-stopped` to the app service (one-line, matches
   flight-notifier); the actual reconnect logic is a real gap left for a
   future day.
```

## Previous day (Day 39) recap

```text
PostgresBookingRepository (reserveSeat/releaseSeat compute in SQL, cancel()
uses RETURNING); OCC proven under real concurrency (20-vs-5-seat race,
10-way double-cancel, both stable); permanent counter-proof of the naive
SELECT-then-UPDATE anti-pattern. All 4 repositories reached dev-complete.
```

## Next

Day 41 — Remove `node:sqlite` from `api` (repositories, migration-runner, migrations.ts, `api/data/booking.db` + its `.gitignore` entry) and decide the unit test strategy now that no SQLite adapter exists to fake against (in-memory fakes vs. real Postgres vs. a mix), per `docs/migration-plan-postgres.md` Section 5.2's revision.
