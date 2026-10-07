# Day 42 — Session Notes

**Theme:** Move `identity` off the Postgres superuser, closing Group B before Group C.
**Status:** Completed — `identity` is no longer the cluster superuser; both the `identity` and
`booking` roles are `NOSUPERUSER`, each owning exactly one database, and `REVOKE CONNECT` now
has real effect in both directions (confirmed via `psql` and via an automated test). Each service
has its own "not-superuser" test; `identity` has its first `test:integration` tier. Verified end
to end on the real stack: migrating as the ordinary role, register/login/promote-to-admin,
create/book/cancel a flight, `flight-notifier` consuming both events.

## Step 0 — Safety prep

```text
Day 41's CURRENT.md was already "Closed" — nothing to change there.
Hit the exact same situation as Day 40: 3 live npm run dev processes
(api PID 67885/67886, identity PID 68084/68085, flight-notifier PID
67795/67796) sharing the Postgres volume that Step 2 needs to wipe.
Stopped them before taking any further action.
```

## Step 1 — Inventory

| Location | Current role |
|---|---|
| `docker-compose.yml:73-75` | Postgres container's superuser bootstrap |
| `docker-compose.yml:87` | Healthcheck `pg_isready -U identity -d identity_db` (hardcoded) |
| `docker/postgres-init/01-create-booking-db.sh:17-33` | Uses `$POSTGRES_USER`/`$POSTGRES_DB` as superuser to create `booking_db` + the `booking` role |
| `.env.example:6-11` | Mislabeled: vars that are actually container bootstrap, tagged "Identity service" |
| `services/identity/src/config.ts:26-31` | Reads `POSTGRES_USER/PASSWORD/DB`, defaults straight to the superuser |

Confirmed the current state before changing anything:
```sql
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb
FROM pg_roles WHERE rolname IN ('identity', 'booking');
```
```text
 rolname  | rolsuper | rolcreaterole | rolcreatedb
----------+----------+---------------+-------------
 identity | t        | t             | t
 booking  | f        | f             | f
```
`identity` confirmed as a real superuser (rolsuper/rolcreaterole/rolcreatedb all `t`); `booking`
matches Day 40's design — none of these three privileges.

## Step 2 — Init scripts: separate the superuser from the `identity` role

```text
docker-compose.yml: POSTGRES_USER/PASSWORD renamed to a neutral identity
  (default postgres/postgres_dev_password), POSTGRES_DB dropped (defaults
  to POSTGRES_USER's value = the "postgres" maintenance database); added
  IDENTITY_POSTGRES_USER/PASSWORD for the init script to read.
New docker/postgres-init/00-create-identity-db.sh (runs before 01-,
  alphabetical order): creates identity_db, the identity role
  (NOSUPERUSER/NOCREATEDB/NOCREATEROLE), ALTER OWNER, REVOKE CONNECT FROM
  PUBLIC — mirrors 01-create-booking-db.sh's existing structure exactly.
Fixed 01-create-booking-db.sh: --dbname "$POSTGRES_DB" -> --dbname postgres
  (since $POSTGRES_DB no longer means identity_db); added NOSUPERUSER/
  NOCREATEDB/NOCREATEROLE to the booking role (consistent with identity);
  changed the trailing REVOKE CONNECT from targeting identity_db
  (redundant with what 00- already does) to targeting booking_db — this
  is the direction that was actually missing: before Day 42 that REVOKE
  had no effect at all (identity bypassed every REVOKE as superuser); now
  that identity is an ordinary role, this REVOKE genuinely blocks it.
```

Confirmed after `docker compose down -v && up`:
```text
psql logs: both 00- and 01- ran cleanly (CREATE DATABASE/CREATE ROLE/
  REVOKE), no errors.
\l: identity_db owner=identity, booking_db owner=booking (no database
  owned by postgres besides postgres/template0/template1).
pg_roles: only "postgres" has rolsuper=t; identity and booking are both
  f/f/f.
Cross-connect blocked in both directions:
  psql -U identity -d booking_db -> FATAL: permission denied for database
    "booking_db" (no CONNECT privilege)
  psql -U booking -d identity_db -> FATAL: permission denied for database
    "identity_db" (no CONNECT privilege)
  Unlike Day 40: back then only one direction actually worked (booking
  blocked from identity_db) because identity was superuser and REVOKE
  didn't affect it. Now both directions are real.
```

## Step 3 — Dedicated environment variables for `identity`

```text
services/identity/src/config.ts: IDENTITY_POSTGRES_USER/PASSWORD,
  fail-fast (parseRequired, mirroring api/src/config.ts exactly),
  replacing the old soft-default POSTGRES_USER/PASSWORD. database is now
  a fixed constant "identity_db" (no longer reads POSTGRES_DB).
.env.example and .env (root, the real file): split into two groups —
  superuser bootstrap (POSTGRES_SUPERUSER/PASSWORD, read only by compose/
  init scripts) and IDENTITY_POSTGRES_USER/PASSWORD (read only by
  identity).
npm run typecheck (identity): clean.
Confirmed at runtime: calling parseIdentityConfig() without
  IDENTITY_POSTGRES_USER -> throws "Missing required configuration:
  IDENTITY_POSTGRES_USER" — same fail-fast behavior as JWT_SECRET.
```

## Step 4 — Protective test: the application must never run as superuser

```text
identity's package.json: "test" changed from the recursive glob
  tests/**/*.test.ts to a flat tests/*.test.ts (mirrors api); added
  "test:integration" (same shape as api's, --test-concurrency=1).
New: services/identity/tests/integration/not-superuser.integration.test.ts
  — 2 tests: rolsuper=false for the identity role; identity cannot
  CONNECT to booking_db. This is identity's FIRST integration tier ever.
New: api/tests/integration/not-superuser.integration.test.ts — the
  symmetric 2 tests for booking (api never had an automated test for
  this direction, only the manual check from Day 40).
Bonus: services/identity/tests/integration/typeorm-user-repository.integration.test.ts
  — create/findByEmail round-trip, duplicate email -> DuplicateEmailError
  (mapped from Postgres's 23505). identity's first test touching a real
  database outside of "not-superuser".
Confirmed the tests actually catch the regression: temporarily pointed
  IDENTITY_POSTGRES_USER/PASSWORD at postgres/postgres_dev_password
  (the superuser) -> both not-superuser.integration.test.ts tests FAILED
  as expected (rolsuper=true, CONNECT to booking_db succeeded) -> reverted,
  back to passing.
Results: identity unit tests 12/12, no Postgres needed; identity
  test:integration 5/5; api unit tests 159/159, no Postgres needed; api
  test:integration 44/44 (including the 2 new not-superuser tests,
  nothing else broke from the role rename/REVOKE changes).
  typecheck:test clean in both workspaces.
```

## Step 5 — End-to-end verification

```text
docker compose down -v && docker compose up -d --build (app and
  flight-notifier containerized; identity run locally via npm run dev —
  there is no identity service in compose).

1. Migration: `npm run migration:run` (identity) as the ordinary identity
   role -> "migrations_completed", count:2. This used to always run as
   the superuser without anyone knowing.
2. Registered a regular user (201) + an admin-to-be (201); logged in as
   the admin-to-be before promotion -> role:"user" in the JWT;
   promote-to-admin admin42@example.com as the ordinary identity role ->
   "User ... is now admin."; logged in again -> JWT payload role:"admin"
   (confirmed by decoding it).
3. api: POST /api/flights (admin token) -> 201; POST
   /api/flights/:id/bookings {passengerName} -> 201; DELETE
   /api/bookings/:id -> 204; second DELETE -> 409
   BOOKING_ALREADY_CANCELLED. flight-notifier logs: both
   flight_created_consumed and booking_created_consumed present, with
   the correct flightId/bookingId.
4. Cross-connect blocked in both directions (confirmed in Step 2 —
   identity cannot reach booking_db, booking cannot reach identity_db).
5. \du: only "postgres" (the renamed superuser) has Superuser/Create
   role/Create DB/Replication/Bypass RLS; "booking" and "identity" have
   no attributes.
```

## Step 6 — Group B retrospective (Day 31 → Day 42)

```text
1. What went right?
   - Separating "dev-complete" from "cutover" (Day 35's plan, one
     repository at a time on Days 36-39, all wired together in a single
     Day 40 commit): production risk was concentrated into exactly one
     day, while each migration was verified independently beforehand.
   - Counter-proof tests, not just happy-path tests: Day 37 kept a
     permanent test showing the "transaction not joined" bug would
     reproduce if anyone reverted to the old pattern; Day 39 has a test
     proving the naive SELECT-then-UPDATE approach genuinely overbooks on
     real Postgres.
   - Reconciling test counts instead of letting the number silently
     drift: Day 41 deleted 34, added 7, matching exactly
     186 - 34 + 7 = 159 — carrying Day 36's lesson (silently losing test
     coverage from a bad glob) forward into a systematic habit.
   - The superuser bug (Day 40) was found organically while verifying an
     unrelated feature (the booking role's privileges), not from a
     dedicated audit — showing the value of hands-on verification over
     assuming things already work.

2. What was surprising?
   - Ports had to go async one at a time as each Postgres adapter was
     added (FlightRepository Day 36, OutboxRepository Day 37,
     AuditRecorder/BookingRepository Day 38-39) — each time rippling
     through every related use case and test. This is exactly why the
     "a port touching I/O declares Promise from the start" rule was
     later added to CLAUDE.md.
   - PostgresFlightRepository silently not joining transactions (Day
     36/37): no exception, every test stayed green, and only a
     purpose-built cross-repository rollback test could reveal it.
   - COMMIT on an already-aborted transaction doesn't throw — Postgres
     silently performs a ROLLBACK instead (Day 38), confirmed via raw
     psql and a raw pg client script.
   - identity had been the cluster superuser the entire time since Day
     31 (discovered Day 40), surfaced while verifying a completely
     unrelated role (booking) — a gap that existed for 9 working days
     without anyone noticing, until unrelated work happened to touch it.

3. What would you do differently?
   - Declare every I/O-touching port as Promise<...> from day one, even
     when the first implementation is synchronous — would have avoided 4
     separate ripple conversions (Flight, Outbox, Audit, Booking).
   - Give each service its own, non-colliding Postgres env var names from
     the very first day it connects to Postgres (Day 31 for identity),
     instead of leaving the cleanup until Day 42 — the superuser gap
     could have been caught right away with a closer look at the var
     names at the time; this is the "could have been known sooner" kind
     of lesson, unlike COMMIT-silently-becomes-ROLLBACK (Day 38), which
     was close to unknowable without reading deep into Postgres's own
     source.
```
