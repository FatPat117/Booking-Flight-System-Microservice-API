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
| 7+ | Next boundary only if route still over-orchestrates | Only when pain appears |

Final destination (architecture level only):

- Multiple services: Identity, Flight, Passenger, Booking
- Express, Postgres/TypeORM, RabbitMQ, CQRS/MediatR-style, Passport JWT, OpenTelemetry, etc.

**Do not implement these until the learning path reaches them.**
