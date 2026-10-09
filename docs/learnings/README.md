# Learnings

Personal notes on techniques and mechanisms this project actually uses — written in your own words, one file per topic.

## How this differs from the other folders

| Folder | Answers | Example |
|--------|---------|---------|
| `docs/adr/` | **Why** we chose X over Y | ADR-001 Outbox pattern |
| `.cursor/progress/` | **What** was built each day | DAY-40.md |
| `docs/learnings/` | **How** a technique works, and what is worth remembering | request tracing with `AsyncLocalStorage` |

## Index

| Note | Topic |
|------|-------|
| [request-tracing-with-async-local-storage.md](./request-tracing-with-async-local-storage.md) | `requestId`, `AsyncLocalStorage`, `correlationId` across services |
| [outbox-and-relay.md](./outbox-and-relay.md) | Atomic write + async delivery, at-least-once, ordering |
| [lazy-reconnect-publisher.md](./lazy-reconnect-publisher.md) | RabbitMQ publisher recovering after a broker restart |
| [domain-model-and-aggregates.md](./domain-model-and-aggregates.md) | Ubiquitous language, entity vs value object, aggregates as consistency boundaries, lifecycles |

Add a row here whenever you add a note.

## File naming

`kebab-case.md`, named after the topic (e.g. `request-tracing.md`, `lazy-reconnect.md`).

## Suggested template

```md
# <Topic>

## The problem it solves
What hurts without it?

## How it works
Short explanation. Link to the real code (path + function name), not copies of it.

## Trade-offs / when NOT to use
What does it cost? When would it be over-engineering?

## Gotchas
Things that surprised you or broke.

## Related
ADR / Day / other learnings.
```

## Rules of thumb

- Point to code in `api/src/...` instead of pasting large blocks — code changes, links stay meaningful.
- Write the "when NOT to use" part; it is the most useful line a month later.
- One topic per file. Short is fine.
