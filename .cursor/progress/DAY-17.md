# Day 17 — Session Notes

**Date completed:** 2026-07-26
**Theme:** Background Jobs — in-process JobScheduler
**Status:** Completed

## Real pressure

```text
Day 16: Composition Root wires HTTP + DB graph
Day 17: periodic work must not live inside request handlers
         and must not scatter setInterval into index.ts
```

## Why not RabbitMQ yet

```text
One service, one process — no cross-service messaging problem.
Broker adds reconnect/ops cost for "run every N ms in this process".
Accept multi-instance duplicate execution consciously.
```

## Delivered

```text
src/jobs/job-scheduler.ts
src/jobs/in-memory-job-scheduler.ts
src/jobs/flights-summary-job.ts
createApplication() registers + starts scheduler
close() → jobScheduler.stop() → database.close()
tests/job-scheduler.test.ts
tests/flights-summary-job.test.ts
```

## Count trade-off

```text
Used findPage({ limit: 1 }).totalItems (existing COUNT(*))
Did not add FlightRepository.count() for a single consumer
Cost: one unused row selected each tick — fine at current scale
```

## Flow

```text
createApplication
  → wire repos / use cases
  → createInMemoryJobScheduler(logger)
  → register(flights-summary-job)
  → start()
  → return Application { close: stop jobs then close DB }
```

## Quality gate

```text
128 tests pass
```

## Remaining limitations

```text
Multi-instance duplicate job runs
No job persistence / crash recovery
Interval not in env config yet
No handler hang timeout
```
