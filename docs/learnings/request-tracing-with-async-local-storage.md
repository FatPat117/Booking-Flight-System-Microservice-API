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

### Why every request goes through the middleware

In `api/src/app.ts` it is registered with `app.use(createRequestObservabilityMiddleware(logger))` — no path, no method — and **before** `express.json` and every route. Express runs middleware in registration order, so:

- Every request is covered, including 404s (they pass through it before reaching `notFoundHandler`) and requests that later fail.
- Two levels, easy to mix up: `createRequestObservabilityMiddleware(logger)` runs **once at startup** and returns `requestObservability`; that returned function runs **once per request**. `logger` is captured by closure (the factory-function style used across the project).

### Why `AsyncLocalStorage` and not a global variable

The server handles many requests at once, and every `await` lets another request run. With `let currentRequestId`, request B would overwrite request A's id mid-flight. `AsyncLocalStorage` gives each request its own store that follows that request's `await`/callback chain:

```
Request A: id=aaa ─ await DB ─ getRequestId() → "aaa"
Request B: id=bbb ─ await DB ─ getRequestId() → "bbb"
```

Outside a request (seed script, future background job) there is no store, so `getRequestId()` returns `undefined`. That is why callers write `...(requestId === undefined ? {} : { requestId })` and use cases take `getRequestId: () => string | undefined` as a dependency instead of a `requestId` parameter.

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

## Interview Q&A

**What is a request id for, and where is it created?**
A single id that ties together every log line, audit row and event produced by one request. Created in the first middleware (client's `x-request-id` if valid, else a UUID) and echoed in the response headers.

**How does deep code get the id without a parameter?**
`AsyncLocalStorage`: the middleware wraps the rest of the request in `runWithRequestContext({ requestId }, ...)`; anything running inside, across `await`s, reads it with `getRequestId()`.

**Why not a module-level variable?**
Concurrent requests would overwrite each other. `AsyncLocalStorage` is per async chain, so each request sees its own value.

**What are the downsides?**
Implicit state: functions that read it behave differently depending on hidden context, which is harder to test (inject `getRequestId` as a dependency to keep unit tests simple). And the id can come from the client, so it is a hint, never trusted.

**Difference between `requestId` and `correlationId`?**
Same value today. `requestId` identifies one HTTP request; `correlationId` links everything in a business flow (request → event → consumer), and can later span several requests (saga).

## Try it

```bash
# send x-request-id: demo-1 on POST /api/flights, then:
docker compose logs app flight-notifier | grep demo-1
```

## Related

- `docs/adr/001-outbox-pattern.md`
- `docs/learnings/outbox-and-relay.md`
- `.cursor/progress/DAY-29.md` (correlationId)
