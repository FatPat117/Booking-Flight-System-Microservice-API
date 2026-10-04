# CURRENT PROGRESS

**Last completed day:** Day 41
**Current day:** Day 41 — SQLite removed from `api`, test strategy without SQLite decided
**Status:** Closed (pending the user's final integration + e2e run before commit) — RabbitMQ publisher now reconnects in-process after a broker restart (verified on the real stack: no stuck outbox rows, app RestartCount 0, graceful stop still exit 0). `node:sqlite` fully removed (src, Dockerfile `/app/data`, `booking_data` volume, ignore files, docs). Unit/HTTP tests run on in-memory fakes; database semantics stay on Postgres integration tests (ADR-005); `BookingRepository` contract test runs on both tiers. SQLite → Postgres recorded as ADR-006; Day 41's deletion is the migration's point of no return.

## Day 41 delivered

```text
Step 0: lazy in-process reconnect in rabbitmq-publisher.ts (no timer —
  the outbox relay's interval is the retry cadence) + 4 unit tests with an
  EventEmitter fake; flight-notifier keeps crash + restart recovery
Step 1: every SQLite-touching test classified before deleting anything —
  34 removed (23 had a Postgres equivalent, 11 no longer meaningful)
Step 2: tests/fakes/in-memory.ts — fakes modeled on the Postgres
  adapters' outcomes, always returning copies, no rollback simulation
Step 3: tests/contracts/booking-repository.contract.ts — 7 cases run on
  the fake (unit) and on Postgres (integration); proven to catch a
  deliberately broken fake
Step 4: group (a) moved to fakes; race tests deleted (Postgres race test
  is now the only guard); added postgres-health-checks integration test
Step 5: 10 SQLite src files + all infra/doc traces removed
Step 6: ADR-005, ADR-006; npm test 186 -> 159 = exactly 186 - 34 + 7
```

## Previous day (Day 40) recap

```text
Cutover: bootstrap wires all Postgres repositories + transaction runner +
health checks; dedicated `booking` role with REVOKE CONNECT on identity_db;
verified end to end on docker-compose incl. an HTTP-level 20-vs-5-seat race.
```

## Next

Day 42 — Move `identity`'s routine connections off the Postgres superuser (Day 40 review point #1; today REVOKE CONNECT protects identity_db from `booking` but not the reverse), closing Group B before Group C (CQRS + Mediator).
