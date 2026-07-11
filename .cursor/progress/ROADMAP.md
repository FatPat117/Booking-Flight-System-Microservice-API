# ROADMAP (Living Document)

> Adjustable. Mentor may change order if a real problem appears earlier — always explain why.

| Day | Theme | Why this order |
|-----|--------|----------------|
| 1 | Express + Flight CRUD in memory | Need a running API before architecture |
| 2 | Runtime validation + business rules (manual) | Day 1 proved `{}` becomes invalid state |
| 3 | Executable behavior checks from test matrix | Protect rules before refactoring structure |
| 4+ | Error consistency, persistence, layers… | Only when pain appears |

Final destination (architecture level only):

- Multiple services: Identity, Flight, Passenger, Booking
- Express, Postgres/TypeORM, RabbitMQ, CQRS/MediatR-style, Passport JWT, OpenTelemetry, etc.

**Do not implement these until the learning path reaches them.**
