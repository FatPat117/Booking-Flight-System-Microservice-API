# ROADMAP (Living Document)

> Adjustable. Mentor may change order if a real problem appears earlier — always explain why.

| Day | Theme | Why this order |
|-----|--------|----------------|
| 1 | Express + Flight CRUD in memory | Need a running API before architecture |
| 2 | Runtime validation + business rules (manual) | Day 1 proved `{}` becomes invalid state |
| 3 | Automated API tests + `createApp()` split | Manual matrix cannot protect refactors |
| 4 | Consistent JSON errors + error middleware | Parser/unknown-route escape the JSON contract |
| 5 | SQLite persistence (`node:sqlite`) | Data must survive process restart |
| 6 | Repository Pattern (Flight) | SQL+HTTP in one file became real pressure |
| 7 | CreateFlight Use Case | POST orchestration still lived in Express |
| 8 | Typed config + env vars | Port/DB path hardcoded blocked multi-env runs |
| 9 | Paginated ListFlights | findAll() unbounded after durable storage |
| 10 | Request ID + structured logs | Multi-layer stack; 500s hard to correlate |
| 11 | Liveness + readiness (SQLite) | /health only proved process was alive |
| 12+ | Auth when who-can-create-Flight becomes real | Next production pressure |

Final destination (architecture level only):

- Multiple services: Identity, Flight, Passenger, Booking
- Express, Postgres/TypeORM, RabbitMQ, CQRS/MediatR-style, Passport JWT, OpenTelemetry, etc.

**Do not implement these until the learning path reaches them.**
