# Day 8 — Session Notes

**Date started:** 2026-07-12
**Theme:** Typed configuration + environment variables
**Status:** COMPLETED (2026-07-12) — Implementation complete — awaiting review

## Real pressure

```ts
PORT = 3000
databasePath = "data/booking.db"
```

hardcoded → cannot run two instances / different envs without editing source.

## Must build

```text
src/config.ts          → parseConfig(env) → AppConfig { port, databasePath }
tests/config.test.ts   → pure unit tests (no process.env mutation)
index.ts               → parseConfig first, then open DB / listen
.env.example           → committed
.env                   → gitignored
package.json           → --env-file-if-exists=.env on dev/start
```

## NOT today

dotenv package, Joi/Zod, ConfigService, DI container, NODE_ENV/JWT/RabbitMQ vars, inject AppConfig into createApp

## Rules

- Missing PORT/DATABASE_PATH → defaults
- Blank provided values → fail
- Invalid PORT → fail before opening DB
- Only read process.env once at startup via parseConfig(process.env)
