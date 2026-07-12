# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 8)

```text
Environment / .env
  → parseConfig() → AppConfig
  → Composition root (index.ts)
  → Express / CreateFlight / Repository / SQLite
```

## Configuration

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `PORT` | No | `3000` | HTTP listening port (`1–65535`) |
| `DATABASE_PATH` | No | `data/booking.db` | SQLite database file (relative or absolute) |

Precedence:

```text
Operating-system environment
  → .env (if loaded)
  → Application defaults
```

Missing values use defaults. Blank or invalid **provided** values fail startup (fail-fast).

Local setup:

```bash
cp .env.example .env
# edit if needed
npm run dev
```

## Application flow

```text
POST → CreateFlight → FlightRepository → SQLite
GET  → FlightRepository
```

## Scripts

```bash
npm run typecheck
npm run typecheck:test
npm run build
npm test
npm start
```

## Current limitations

- Configuration only covers port and SQLite path
- No external secret/config management
- Use case / repository still synchronous
- Manual validation (verbose on purpose)
- Schema via `CREATE TABLE IF NOT EXISTS` — not migrations
- No auth, pagination, structured logging, events
