# Day 32 — Session Notes

**Date completed:** 2026-09-12
**Theme:** JWT login — Identity issues access tokens
**Status:** Completed (issue only; api verify is Day 33)

## Why JWT is signed, not encrypted

```text
header.payload.signature — header + payload are Base64URL (anyone can read).
Signature proves the token was not tampered with after signing with JWT_SECRET.
Never put secrets in the payload (password, card numbers).
Today's payload: { sub: userId, email } only — no roles yet (no RBAC pain).
```

## Why TokenIssuer is a port

```text
Same reason as PasswordHasher / MessagePublisher:
login.ts depends on "issue a token", not on jsonwebtoken HMAC details.
Swap algorithm or token mechanism later without rewriting login.
```

## Why one error message for bad email and bad password

```text
Different messages = user enumeration (attackers learn which emails are registered).
Both cases → 401 INVALID_CREDENTIALS + "Email or password is incorrect".
UX clarity vs security trade-off — security wins for credentials.
```

## Delivered

```text
JWT_SECRET (≥32) + JWT_EXPIRES_IN (default 1h) fail-fast in config
TokenIssuer port + JwtTokenIssuer (jsonwebtoken.sign)
PasswordHasher.compare via bcrypt (no string === on hashes)
POST /api/identity/login → 200 { accessToken, expiresIn } / 401 / 422
Unit + HTTP tests (identical 401 bodies for missing email vs wrong password)
Postman login requests; accessToken saved to environment
```

## Open question (Day 33)

```text
api must verify with the same JWT_SECRET.
How should services share it — copy env by hand, or something better?
Do not solve today; only note the coupling.
```

## Not today

```text
JWT verify middleware on api
Replace ADMIN_API_KEY
Refresh tokens
Roles / claims beyond sub + email
```
