# Day 3 — Session Notes

**Date started:** 2026-07-11
**Theme:** Automated API testing + app/startup separation
**Status:** Student executing

## Why this day exists

```text
Want to import Express app for tests
  → but import index.ts runs app.listen()
  → tests depend on port + process lifecycle
```

Architecture change appears only because of that real pain:

```text
createApp()  ≠  app.listen()
```

## Must build

```text
src/app.ts          → createApp(), no listen
src/index.ts        → bootstrap only
tests/flights.api.test.ts
tsconfig.test.json
scripts: test, test:watch, typecheck:test
```

## Stack today

- `node:test` + `node:assert/strict`
- Supertest (+ @types)
- NO Jest, Vitest, mocks, Testcontainers, Faker

## Intentionally NOT

Controller/Service/Repo/DI/DB, centralized error middleware, Jest

## Quality gate

```bash
npm run typecheck
npm run typecheck:test
npm run build
npm test
npm start
```

## After completion

Send commit for PR review — do not self-mark Ready for Day 4 until approved.
