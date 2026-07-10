# Day 1 — Session Notes

**Date started:** 2026-07-10
**Theme:** Single Express API — Flight resource + in-memory array
**Status:** COMPLETED (2026-07-10) — Location header verified

## Architecture target today

```text
Client → HTTP → Node.js → Express → Route Handler → In-memory Flight[]
```

## Must build

| Method | Endpoint | Behavior |
|--------|----------|----------|
| GET | `/health` | 200 `{ status: "ok" }` |
| GET | `/api/flights` | 200 array (empty = `[]`, not 404) |
| GET | `/api/flights/:id` | 200 or 404 JSON error |
| POST | `/api/flights` | 201 + Location + server UUID |

## Stack (pinned)

- Node.js 24 LTS
- Express 5
- TypeScript 6
- tsx (dev)
- In-memory only

## Folder (only this)

```text
booking-system-evolution/
├── src/index.ts
├── .gitignore
├── package.json
├── package-lock.json
└── tsconfig.json
```

## Intentionally NOT today

DB, Docker, validation libs, service/repo/DI, auth, RabbitMQ, microservices, CQRS.

## Known accepted limitations

- Data lost on restart
- `as CreateFlightRequest` ≠ runtime validation
- Hardcoded port 3000
- Routes own both HTTP + data

## After student finishes

1. Manual curl checklist (health, empty list, create, get, 404, invalid `{}`, restart)
2. Push GitHub → send URL + branch + commits for PR-style review
3. Mentor updates CURRENT.md → Day 2
