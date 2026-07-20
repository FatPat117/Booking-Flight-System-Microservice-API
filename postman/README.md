# Postman

Import these files into Postman:

1. `Booking-microservices.postman_collection.json`
2. `Booking-microservices.local.postman_environment.json`

Select the **Booking Microservices — Local** environment before sending requests.

## Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `baseUrl` | `http://localhost:3000` | Match `PORT` in `.env` |
| `adminApiKey` | `local-admin-key-123456789` | Must match `ADMIN_API_KEY` in `.env` (min 16 chars) |
| `flightId` | empty | Auto-set after successful `POST /api/flights` |
| `requestId` | `postman-manual-001` | Sent as `x-request-id`; used in logs and audit |

## Start server

```bash
npm run dev
# or
npm run build && npm start
```

## Current coverage (Day 13)

- Health: `GET /live`, `GET /health`, `GET /ready`
- Flights read (public): `GET /api/flights`, `GET /api/flights/:id`
- Flights write (Bearer auth): `POST /api/flights`
- Error examples: 401, 422, 409 duplicate

Audit trail is persisted in SQLite (`audit_logs`) on successful create — no HTTP endpoint yet. Inspect with SQLite CLI if needed.
