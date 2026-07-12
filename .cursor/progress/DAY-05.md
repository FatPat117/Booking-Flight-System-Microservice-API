# Day 5 — Session Notes

**Date started:** 2026-07-12
**Theme:** File-backed persistence with SQLite (`node:sqlite` + direct SQL)
**Status:** COMPLETED (2026-07-12) — mentor reviewed & corrected — awaiting formal re-review if desired

## Real pressure

```text
Process restart → Flight[] cleared
Need data to survive process lifecycle
```

## Must build

```text
src/database.ts     → openDatabase(path), STRICT schema, UNIQUE
createApp(database) → no Flight[], prepared statements, SQL in routes
src/index.ts        → data/booking.db, mkdir, shutdown close
tests               → :memory: per test + file persistence + shared file
.gitignore          → data/
```

## NOT today

PostgreSQL, Docker, ORM, Repository, Service, DI, migrations, JSON file store

## Signature change

```ts
createApp() → createApp(database: DatabaseSync)
```

## Quality gate

```bash
npm run typecheck && npm run typecheck:test && npm run build && npm test && npm start
# then restart and verify GET /api/flights still has data
```

## Prerequisite

Node 24+ with `node:sqlite` (RC). Verify before coding.
