# Day 12 — Session Notes

**Date completed:** 2026-07-20
**Theme:** API Key Authentication for Write Endpoint
**Status:** Completed

## Delivered

- `ADMIN_API_KEY` in config (required, min 16 chars, fail-fast)
- `src/auth/api-key-auth.ts` — Bearer middleware on POST only
- 401 UNAUTHENTICATED + WWW-Authenticate: Bearer
- GET + health remain public
- `tests/api-key-auth.test.ts` + updated POST test helpers
- `.env.example` + README
- 101 tests pass

## Intentionally deferred

JWT, OAuth, Keycloak, RBAC, users, key rotation, log raw token
