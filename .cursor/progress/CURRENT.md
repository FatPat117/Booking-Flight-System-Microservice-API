# CURRENT PROGRESS

**Last completed day:** Day 31
**Current day:** Day 31 — Identity service (Postgres/TypeORM + register)
**Status:** Code complete — register works on :3001; JWT not started

## Day 31 delivered

```text
postgres in docker-compose (healthy + volume)
services/identity — TypeORM UserEntity, migration, POST /api/identity/register
bcrypt cost 12; UNIQUE email + 409 on duplicate; no passwordHash in response
5 identity unit/API tests pass; smoke against Postgres PASS
```

## Next

Day 32 (when assigned) — JWT login on Identity; still no verify middleware on api.
