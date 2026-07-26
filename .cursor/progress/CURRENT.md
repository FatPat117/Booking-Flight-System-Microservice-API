# CURRENT PROGRESS

**Last completed day:** Day 17
**Current day:** Day 17 — Background Jobs
**Status:** Completed — awaiting mentor review / commit

## Day 17 delivered

```text
JobScheduler interface + in-memory scheduler (no overlap)
flights-summary-job → Logger flights_summary
Composition Root starts jobs; close() stops jobs then DB
```

- `src/jobs/job-scheduler.ts`
- `src/jobs/in-memory-job-scheduler.ts`
- `src/jobs/flights-summary-job.ts`
- `tests/job-scheduler.test.ts`
- `tests/flights-summary-job.test.ts`
- README background jobs section

## Next

Day 18 — Docker (when assigned).
