---
name: day-close
description: Close a finished learning day in this repo — progress log, CURRENT.md, README, Postman, English learnings and the Vietnamese study notes, link check, reconciled test counts, a suggested commit message. Use when the user says the day is done, asks for the end-of-day docs, or types /day-close.
---

# Closing a day

Work through every item in order. For each one, say "done" with the file and
line links, or "not needed today" with the reason. Skip nothing silently.

## Ground rules

- **Never `git commit`.** End with a suggested commit message only (see the last step).
- **Ask before touching the dev stack**: rebuilding the app, migrations on
  `booking_db`, creating e2e data, purging queues, `docker compose down -v`
  (check `ps aux | grep tsx` first).
- Every repo file is English, except `docs/learnings/vietnamese/`.

## 1. Evidence first

- Final counts for unit (`npm test --workspace=api`), integration
  (`npm run test:integration --workspace=@booking-flight-system/api`, on
  `booking_test`, one suite at a time), notifier and identity. Reconcile each
  as `before − removed + added = after`, and name the files that were added.
- Full Postman collection: `./postman/run-all.sh`. Ask first, because it
  creates data in `booking_db`. Record the request and assertion counts of
  both parts. If the day added endpoints, add a `Day XX — …` folder to the
  collection and to the folder lists in `run-all.sh`, using the Setup
  folder's run variables, never fixed names.

## 2. Progress log

- `.cursor/progress/DAY-XX.md`: what was built and why, decisions, measured
  numbers with their conditions (data volume, one client, median of N, warm
  or cold cache), incidents and what fixed them, the test reconciliation,
  "Not today", and the suggested commit message at the end.
- `.cursor/progress/CURRENT.md`: last completed day, status line with the
  counts, what the day delivered, open items carried forward, the data left
  in `booking_db`, and what comes next.

## 3. Product and architecture docs

- `docs/product/domain-model.md`: decisions, lifecycle tables, BR rows
  (✅ with the day), phase-D order and status.
- `docs/product/scope.md`: user stories and acceptance criteria that changed.
- `docs/adr/`: a new ADR only for a decision with real alternatives. Add its
  row to the ADR index.
- `docs/roadmap.md`: only if the plan genuinely changed. Add a line to
  "Roadmap history" explaining why, and an ADR if the order of phases changed.
- `README.md`: new endpoints, jobs, audit actions, migrations, and the
  limitations list (drop the ones that were fixed).
- `postman/README.md`: anything a reader needs to run the new folder.

## 4. English learnings

- `docs/learnings/<topic>.md` for the day's technique, plus its index row.
  Cover the problem, how it works, what was measured, and interview questions.

## 5. Vietnamese study notes (`docs/learnings/vietnamese/`)

- `on-tap-nhanh-day-01-XX.md`: add the day's row to the timeline, plus any
  new technique, measured number or gotcha. Rename the file to the new last
  day with `git mv`, and fix every link to it.
- `race-conditions/`: a new file, or an update, when the day handled contested writes.
- `interview/`: new Q&A when the day produced something worth explaining in an interview.
- `use-cases/`: new or changed endpoints, outcomes and HTTP mappings.
- `migrations/danh-sach.md`: every new migration, what it does and why.
- `README.md`: bump the "Cập nhật đến Day XX" line.
- Link check: every relative link in `docs/learnings/vietnamese/` still
  resolves. Report the number of files checked and the number broken.

## 6. Hand-off

- Run `npm run typecheck` and `npm run typecheck:test` one last time. Both must show 0 errors.
- Summarize for the user in Vietnamese: what was done, the counts, the e2e
  and Postman results, the docs touched, and anything that differs from the
  brief.
- Suggest a commit message: a short subject (`feat(api): … (Day XX)`), an
  optional body, and the attribution line. Put **no double quotes** inside
  the message, because the user pastes it into `git commit -m "…"`. Also
  offer the `git commit -F <file>` form.
