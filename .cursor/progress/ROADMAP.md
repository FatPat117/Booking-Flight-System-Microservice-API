# ROADMAP (Living Document)

> Adjustable. Mentor may change order if a real problem appears earlier — always explain why.

| Day | Theme | Why this order |
|-----|--------|----------------|
| 1 | Express + TypeScript skeleton + health check | Need a running process before any architecture |
| 2 | First domain resource (Flight) + in-memory CRUD | Prove HTTP + data shape without DB |
| 3 | REST semantics & status codes | Correct API contract before complexity |
| 4 | Validation | Bad input becomes a real pain |
| 5 | Error handling consistency | Errors multiply with more endpoints |
| 6+ | Auth, persistence, repo, DI, messaging, split services… | Only when pain appears |

Final destination (architecture level only):

- Multiple services: Identity, Flight, Passenger, Booking
- Express, Postgres/TypeORM, RabbitMQ, CQRS/MediatR-style, Passport JWT, OpenTelemetry, etc.

**Do not implement these until the learning path reaches them.**
