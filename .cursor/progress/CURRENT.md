# CURRENT PROGRESS

**Last completed day:** Day 23
**Current day:** Day 23 — Dead Letter Queue (DLQ)
**Status:** Completed — code + Bước 3 DLQ experiment verified

## Day 23 delivered

```text
flight-created.dlx + flight-created.dlq declared in flight-notifier consumer
Main queue: x-dead-letter-exchange → DLX; nack(requeue:false) routes to DLQ
Publisher asserts compatible DLX/queue args (avoids PRECONDITION_FAILED)
DLQ = manual investigation only — no auto-retry
Upgrade: docker compose down -v before first run with DLQ args
```

## Next

When assigned — auto-retry with x-death, shared contract package, or next domain.
