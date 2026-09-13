# Day 34 — Session Notes

**Date completed:** 2026-09-13
**Theme:** Migrate admin write routes to JWT + role
**Status:** Completed — `POST /api/flights` requires admin JWT; `ADMIN_API_KEY` removed

## Why remove ADMIN_API_KEY entirely

```text
JWT already proves identity (sub, email). Role proves admin privilege.
Keeping both auth mechanisms in parallel is redundant operational surface
(two secrets, two failure modes, two Postman paths).
```

## Why a single role column (not roles/permissions tables)

```text
Only one distinction exists today: admin vs not.
A join table would prepare for a product need that is not present.
```

## Why promote-to-admin is a CLI, not a public API

```text
Register must not let callers self-elevate. First admin is an ops action.
```

## Why 403 vs 401 for wrong role

```text
401 = identity unknown/unproven (missing/invalid/expired token).
403 = identity known, privilege insufficient.
```

## Delivered

```text
Identity: users.role ('user'|'admin'), migration, promote-to-admin script
JWT payload includes role; login issues it
api: AuthenticatedUser.role, verifyJwt validates role claim
requireRole('admin') middleware
POST /api/flights → requireJwt + requireRole('admin')
Removed ADMIN_API_KEY from config, compose, .env.example, api-key-auth
Tests + Postman use admin JWT
```

## Intentional leftover

```text
Audit actor for FLIGHT_CREATED still typed as admin_api_key —
auth gate migrated; audit actor shape not part of Day 34 brief.
```

## Not today

```text
Migrate api SQLite → Postgres/TypeORM (Day 35+)
Rich RBAC / permission tables
```
