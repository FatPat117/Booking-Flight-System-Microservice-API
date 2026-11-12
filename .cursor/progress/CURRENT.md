# CURRENT PROGRESS

**Last completed day:** Day 52
**Current day:** Day 52 — Flight cancellation cascade (phase D step 9)
**Status:** ✅ Complete — unit 614/614, integration 292/292 (on `booking_test`), notifier 20/20,
identity 12/12 + integration 7/7 (on `identity_test`, untouched), race matrix A–G 10 runs in a row,
end-to-end verified (HTTP + psql + notifier logs + newman Day 52 15/15). `POST /api/flights/:id/cancel`
changes only the flight (compare-and-set + audit, 3–8 ms) and answers `remainingBookings`; the
`flight-cancellation-cascade-job` (30 s) cancels each live booking in its own transaction through the
shared cancel core with reason `AIRLINE` (stored in `bookings.cancellation_reason`), refunds through
reconciliation. Payment confirmation loses to a cancelled flight (share lock on the flight row). The
Day 47 deadlock hypothesis held for the one-transaction design (3/3 `40P01`, test-only control) and
not for the chosen one (0). Decision 18, ADR-011.

## Day 52 delivered

```text
Step 0: HELD-seats dependency at both ends, cursor "bound to the query", measurement conditions
Step 1: Decision 18, lifecycle + lock-order tables, US-OPS-01 rewritten (reason AIRLINE), BR-FLT-07
Step 2: CancelFlight + POST /api/flights/:id/cancel, countLiveOnFlight, gated hold-vs-cancel tests
Step 3: AddBookingCancellationReason, reason-aware cancel core, claim + cascade job, event reason
Step 4: confirmHold shares the flight and refuses CANCELLED; race B1–B3, control B', mutation
Step 5: invariants (AIRLINE ⇒ cancelled flight, no confirm after cancel, cascade complete),
        race A–G + A' control + A (queue), measurements B vs A
Step 6: e2e 6 scenarios, Postman Day 52 (newman 15/15), README, ADR-011, learnings (EN + VI)
```

## Previous day (Day 51) recap

```text
Flight search on the origin's local dates with seats in one class, keyset pages, details per class;
measured live counting on 3.9 M seats (no read model yet).
```

## Next

Day 53 — Phase D retrospective and phase E preparation (no code, like Day 42B and Day 43): look back at
the evidence gathered (search measurements, repetition across use cases, the jobs and shared
pipelines) to judge CQRS + Mediator honestly. First question: phase D step 10 (admin reports,
read-only) is still in the domain-model order — do it before the retrospective, or move it to E?

Open items carried (see DAY-52 "Not today"): payment phase 1 does not check the flight; a cancel can
be delayed by a stream of holds; the cascade claim reads every cancelled flight's bookings; a
cancelled flight's number cannot be reused at the same departure; `REFUND_FAILED` has no endpoint or
alert; no way to learn a refund finished; the simulator's provider memory is in-process; the outbox
relay is not multi-instance safe and consumers do not dedupe by `eventId`; no fare-change endpoint,
deprecated `priceInCents`, removing the `booking-created` contract, the release `ORDER BY` survivor;
no fare-class filter in search.

e2e data left in `booking_db`: Day 51's 7 flights on 22–25 Dec and VN511–514 on 12–13 Jan 2027; Day
52's VN521 (15 Feb 2027) and VN522 (16 Feb 2027), both cancelled. To rerun the Postman Day 51 / Day 52
folders, delete VN511–514 / VN522 first (`postman/README.md` step 21 has the SQL for VN522). The full
collection was not re-run after the Day 51 `fareClass` change: a fresh context running all folders
must clean that data and check the older folders.
