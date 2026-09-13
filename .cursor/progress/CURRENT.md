# CURRENT PROGRESS

**Last completed day:** Day 34
**Current day:** Day 34 — Migrate admin routes to JWT + role
**Status:** Code complete — `POST /api/flights` uses `requireJwt` + `requireRole('admin')`; `ADMIN_API_KEY` removed

## Day 34 delivered

```text
Identity users.role + migration + promote-to-admin CLI
JWT payload includes role; verifyJwt validates it
requireRole middleware (401 missing auth / 403 wrong role)
POST /api/flights on JWT admin only; ADMIN_API_KEY gone
```

## Next

Day 35 — Group B: evaluate and plan migrating `api` from SQLite to Postgres/TypeORM (reuse Identity experience).
