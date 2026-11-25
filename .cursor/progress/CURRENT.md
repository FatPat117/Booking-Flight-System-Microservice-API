# CURRENT PROGRESS

**Last completed day:** Day 53
**Current day:** Day 53 — Read-only admin reports (phase D step 10). **Phase D is complete.**

**Status:** ✅ Complete.
- Tests: unit 640/640, integration 309/309 (on `booking_test`), notifier 20/20, identity 12/12 +
  integration 7/7 (on `identity_test`, untouched).
- e2e: 5 scenarios on the compose stack.
- Postman: the whole collection (206 requests) green twice in a row with `./postman/run-all.sh`.

What the day added:
- Three admin reports behind a second read port, `AdminReports`.
- The manifest:
  - lists `CONFIRMED` passengers only, four fields each;
  - is read in one `REPEATABLE READ READ ONLY` snapshot;
  - records every view as `FLIGHT_MANIFEST_VIEWED`.
- Load factor by the origin's local dates.
- The audit log with a required target or range, and the first audit indexes, shaped by that query.
- Day 52 review items:
  - payment phase 1 refuses a cancelled flight;
  - `flights.cascade_completed_at` with a flight-first claim;
  - the Postman collection is rerunnable on any database.
- Decision 19.

## Day 53 delivered

```text
Step 0: phase 1 refuses CANCELLED (not CLOSED, BR-PAY-06); cascade_completed_at + claim ordered by
        flight (EXPLAIN 39 213 → 1 buffer); Postman Setup folder + run-all.sh, two green runs
Step 1: Decision 19, US-ADM-01..03, the private-data cursor question answered
Step 2: AdminReports port + three reports + routes, AddReportIndexes (CONCURRENTLY), statement counts
        pinned, EXPLAIN before/after on 300 000 audit rows (48.8 ms → 0.08 ms by target)
Step 3: snapshot race test with a gate + READ COMMITTED control (3 booked above 1 passenger), mutation
Step 4: matrix A–G: differential over 30 seeds, manifest vs inventory, paging through ties, 3 mutations
Step 5: read-side evidence table for Day 54 (every read < 12 ms; repetition is on the write side)
Step 6: e2e 5 scenarios + logs free of names, Postman Day 53 folder, docs, /day-close skill
```

## Previous day (Day 52) recap

```text
Flight cancellation cascade: the admin's cancel changes only the flight; a state-driven job cancels
each live booking (reason AIRLINE); payment confirmation loses to a cancelled flight.
```

## Next

**Day 54: phase D retrospective and phase E preparation (no code).**
- Use the evidence table in `.cursor/progress/DAY-53.md` ("Evidence for Day 54: the read side") to
  judge CQRS and a mediator honestly.
- Decide where phase E starts.
- What the table shows:
  - no read is slow;
  - the read side split into two ports on its own;
  - the measured repetition is on the write side: 11 use cases share "transaction + write + audit",
    and 4 jobs share the `SKIP LOCKED` claim shape.

## Working setup

- **Close a day with `/day-close`** (`.claude/skills/day-close/SKILL.md`; Cursor reads the same
  file).
- **The pre-push progress hook was removed** (Day 53). `.cursor/progress/` is updated only at day
  close.
- **`./postman/run-all.sh` runs the whole collection** on any `booking_db`. It starts identity if
  nothing answers on :3001.
- **Test scripts have timeouts** (unit 60 s, integration 120 s per test), so a hang fails with a name.
- **Volume tooling on `booking_test`:**
  - `npm run perf:search:seed`, then `perf:reports:seed`;
  - `perf:search:explain`, `perf:reports:explain -- <label>`, `perf:reads:measure`.
  - The integration suite truncates that data.

## Open items carried

- **Load factor and the manifest count seats on every request.** Covering index or per-class
  counter, when reports span thousands of flights.
- **The audit log by actor alone** has no index.
- **`audit_logs` has no retention.**
- **The intermittent unit-suite hang** (`flights.api.test.ts`, once): now times out by name.
- **The outbox relay is not multi-instance safe**, and consumers do not dedupe by `eventId`.
- **`REFUND_FAILED`** has no endpoint or alert.
- **A cancel can be delayed** by a stream of holds.
- **The simulator's provider memory** is in-process.
- **Cancelled flights block their number:** a cancelled flight's number cannot be reused at the same
  departure.
- **Fares and search leftovers:** no fare-change endpoint, deprecated `priceInCents`, the
  `booking-created` contract removal, no fare-class filter in search.

## Data in `booking_db`

- e2e flights from Days 51–53:
  - Day 51: 7 flights on 22–25 Dec, VN511–514;
  - Day 52: VN521, VN522, both cancelled and cascade-complete;
  - Day 53: VN53FC43 on 2027-01-15, on its own aircraft VN-RFC43.
- Postman data of four full runs, named by their run codes. No cleanup is needed: every run
  generates its own names.
