# CURRENT PROGRESS

**Last completed day:** Day 32
**Current day:** Day 32 — JWT login (issue token on Identity)
**Status:** Code complete — `POST /api/identity/login` issues JWT; api still uses `ADMIN_API_KEY`

## Day 32 delivered

```text
JWT_SECRET / JWT_EXPIRES_IN fail-fast in identity config
TokenIssuer + JwtTokenIssuer; login use case + bcrypt.compare
Unified 401 for unknown email / wrong password (no enumeration)
Tests: issuer, login outcomes, HTTP 200/401 identical bodies
```

## Next

Day 33 — share `JWT_SECRET` correctly + middleware verify token on `api`, replace `ADMIN_API_KEY`.
