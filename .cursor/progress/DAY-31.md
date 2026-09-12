# Day 31 — Session Notes

**Date completed:** 2026-09-12
**Theme:** Identity service pilot — Postgres/TypeORM + register
**Status:** Completed (code + unit tests + migration + smoke register)

## Why Identity is a separate service

```text
api owns flight/booking lifecycle.
Identity owns who the user is (email, password hash) — will serve multiple consumers later.
Embedding users inside api would force other services to call booking API for auth.
```

## Why Postgres + TypeORM starts here (not rewriting api)

```text
Smallest surface: one entity, one endpoint, one DB.
api stays on node:sqlite until there is pressure to migrate it.
TypeORM synchronize: false — migrations remain the schema source of truth.
```

## Why register before JWT

```text
Isolate storage + hashing first.
JWT issue (login) and JWT verify (api middleware) come later — one concern at a time.
```

## Delivered

```text
docker-compose postgres:16-alpine + identity_postgres_data + healthcheck
services/identity workspace (@booking-flight-system/identity) port 3001
UserEntity + hand-reviewed CreateUsers migration (UNIQUE email)
POST /api/identity/register — validate, bcrypt cost 12, 201/409/422
passwordHash never in response; DB stores $2b$12$...
Unit tests with in-memory UserRepository (5 pass)
Smoke: migration:run + register 201 + duplicate 409 against real Postgres
```

## Race note (same as Day 26 spirit)

```text
App checks findByEmail then create.
UNIQUE(email) + catch 23505 → duplicate_email if two registers race.
```

## Not today

```text
JWT / login
tsyringe / Joi
Dockerfile for identity in compose (dev via npm run dev)
Rewriting api to Postgres
```
