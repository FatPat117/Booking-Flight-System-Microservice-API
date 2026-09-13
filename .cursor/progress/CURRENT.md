# CURRENT PROGRESS

**Last completed day:** Day 33
**Current day:** Day 33 — JWT verify middleware on `api`
**Status:** Code complete — `/api/whoami` verifies JWT; flight/booking still use `ADMIN_API_KEY`

## Day 33 delivered

```text
JWT_SECRET shared via root .env + docker-compose app env
request-context.authenticatedUser (optional)
verifyJwt middleware (missing / expired / invalid) + tests
GET /api/whoami probe only — no flight/booking migration yet
```

## Next

Day 34 — migrate `POST /api/flights` (and other admin routes) from `ADMIN_API_KEY` to `verifyJwt`; decide if roles are needed yet.
