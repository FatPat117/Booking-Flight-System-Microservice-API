# Request tracing: `requestId`, `AsyncLocalStorage`, `correlationId`

## The problem it solves

One HTTP request produces log lines in several places (route, use case, repository), then an event that another process (`flight-notifier`) logs much later. Without a shared id, you cannot answer "what happened to *this* request?" — logs from concurrent requests interleave.

Passing `requestId` as a parameter through every function would pollute every signature.

## How it works

Three pieces, each with one job:

1. **Middleware creates the id** — `api/src/observability/request-observability.ts`
   - Uses the client's `x-request-id` if usable (non-empty, ≤128 chars), else `randomUUID()`.
   - Echoes `x-request-id` and `x-correlation-id` on the response.
   - Logs `request_started`, and `request_finished` (with `statusCode`, `durationMs`) on the response `finish` event.
2. **`AsyncLocalStorage` carries it** — `api/src/observability/request-context.ts`
   - `runWithRequestContext({ requestId }, ...)` opens a store; everything `await`ed inside sees the same store.
   - Each request gets its own store, so concurrent requests never mix.
   - The JWT middleware later adds `authenticatedUser` to the same store.
3. **Logger reads it automatically** — `api/src/observability/logger.ts`
   - `createLogEntry` calls `getRequestContext()` and adds `requestId` to every line. Deep code logs correctly without being given the id.

### From request to event

Use cases (e.g. `api/src/flights/create-flight.ts`) call `getRequestId()` (wired in `bootstrap/application.ts`) and then `resolveCorrelationId(requestId, eventId)` (`api/src/outbox/resolve-correlation-id.ts`):

- Has a request → `correlationId = requestId`.
- No request (e.g. a future internal job) → `correlationId = eventId`, the event correlates with itself.

The `correlationId` is written into the **audit row** and the **outbox payload**, so `flight-notifier` can log it after consuming. One id links:

```
Postman x-request-id → api logs → audit/outbox row → RabbitMQ → flight-notifier log
```

## Why logging is centralized (and not a "logging behavior")

Start/finish logging is identical for every route, so it lives once in the middleware. What differs per command is the **audit** content and **outbox** payload — those are not generic enough to extract into a shared pipeline behavior without passing everything in. A behavior/pipeline layer would repeat what the middleware already does; add it only when many commands repeat the same boilerplate.

## Trade-offs / when NOT to use

- `AsyncLocalStorage` is implicit global-ish state: convenient, but code that reads it is harder to test without setting up a context (see `setAuthenticatedUser`, which throws outside one).
- `requestId` can come from the client, so treat it as a **correlation hint, never a trusted or secret value**.
- Overkill for a single-process app with a handful of logs; it pays off once events cross process boundaries.

## Gotchas

- `correlationId` equals `requestId` today. They are kept as separate names on purpose, so they can diverge later (e.g. a saga spanning several requests).
- `identity` (`:3001`) has **no** request logging yet, so login/register leave no trace there.
- Audit `actor` in `create-flight.ts` still says `admin_api_key`/`"admin"` although the route now uses a JWT — it does not yet record the real user.

## Try it

```bash
# send x-request-id: demo-1 on POST /api/flights, then:
docker compose logs app flight-notifier | grep demo-1
```

## Related

- `docs/adr/001-outbox-pattern.md`
- `docs/learnings/outbox-and-relay.md`
- `.cursor/progress/DAY-29.md` (correlationId)
