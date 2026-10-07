# CURRENT PROGRESS

**Last completed day:** Day 42
**Current day:** Day 42 — `identity` off the Postgres superuser, Group B closed
**Status:** Closed — `identity` no longer connects as the cluster superuser (it was, by
accident, since Day 31: `POSTGRES_USER`/`PASSWORD` collided with the Postgres image's own
bootstrap vars). Both `identity` and `booking` are now dedicated `NOSUPERUSER` roles, each owning
exactly one database; `REVOKE CONNECT` protects both directions for real (verified via `psql` and
via a new `not-superuser.integration.test.ts` per service). `identity` has its first integration
test tier (`npm run test:integration`), plus a bonus `TypeormUserRepository` test (create,
duplicate email → `23505`). Verified end to end on the real stack: migrations + promote-to-admin
run as the ordinary `identity` role, register/login/promote/login-again, flight/booking/cancel
through `api`, `flight-notifier` consuming both events. `docs/architecture-overview.md` updated.
Group B (Day 31 → 42) retrospective written.

## Day 42 delivered

```text
Step 0: 3 live npm run dev processes (api/identity/flight-notifier) found
  and stopped before `docker compose down -v`, per the Day 40 lesson now
  written into CLAUDE.md.
Step 1: inventory confirmed the exact bug — docker-compose.yml's postgres
  service and identity/src/config.ts both read POSTGRES_USER/PASSWORD/DB;
  identity was rolsuper=t/rolcreaterole=t/rolcreatedb=t.
Step 2: postgres service's bootstrap vars renamed to a neutral superuser
  (POSTGRES_SUPERUSER); new docker/postgres-init/00-create-identity-db.sh
  creates identity_db + a NOSUPERUSER identity role (mirrors booking's);
  01-create-booking-db.sh's REVOKE CONNECT fixed to target booking_db (was
  redundantly targeting identity_db) — this is the direction that used to
  be meaningless, since identity bypassed every REVOKE as superuser.
Step 3: identity/src/config.ts: IDENTITY_POSTGRES_USER/PASSWORD, fail-fast,
  mirroring api's BOOKING_POSTGRES_USER/PASSWORD pattern exactly.
Step 4: tests/integration/not-superuser.integration.test.ts added to both
  identity and api (identity's is its first integration tier at all);
  bonus typeorm-user-repository.integration.test.ts. Verified the test
  actually catches the regression (pointed it at the superuser, watched it
  fail, reverted).
Step 5: full end-to-end pass on docker-compose + identity via npm run dev:
  migration/promote-to-admin as ordinary identity, flight/booking/cancel
  through api, flight-notifier consuming both events, cross-connect blocked
  both directions, \du shows only the renamed superuser as Superuser.
Step 6: docs/architecture-overview.md updated (Postgres roles section);
  Group B retrospective (3 questions) written into DAY-42.md.
```

## Previous day (Day 41) recap

```text
node:sqlite fully removed from api; unit/HTTP tests moved to in-memory
fakes, database semantics stay on Postgres integration tests (ADR-005);
BookingRepository contract test runs on both tiers; SQLite → Postgres
migration recorded as ADR-006.
```

## Next

Day 43 — Start Group C. Like Day 35, an assessment day first: evaluate what real problem CQRS
and Mediator would solve in the current codebase before introducing either.
