# Day 16 — Session Notes

**Date completed:** 2026-07-26
**Theme:** Manual Dependency Injection & Composition Root
**Status:** Completed

## Why order changed

```text
Docker packages a process.
DI organizes a growing object graph.
Jobs / broker / cache arrive next — wiring pain comes first.
```

## Real pressure

```text
Day 15: index.ts manually news repository, audit, transactions, use cases
Day 16+: scheduler, jobs, broker, publishers would make index hundreds of lines
```

## Delivered

```text
src/bootstrap/application.ts
  createApplication() / Application / close()
  database kept private (not on Application type)
src/index.ts
  parseConfig → runtime → expressApp → httpServer / shutdown
tests/application.test.ts
README Composition Root section
ROADMAP: Day 16 DI → Day 17 Jobs → Day 18 Docker → Day 19+ RabbitMQ
```

## Flow

```text
createApplication(config)
  → openDatabase → migrations
  → Repository / Audit / Transaction / Health / Logger
  → CreateFlight / ListFlights
  → Application { ..., close() }  // no public database
        ↓
index.ts → runtime / expressApp / httpServer
        ↓
SIGINT/SIGTERM → runtime.close()
```

## Quality gate

```text
123 tests pass
```

## Remaining limitations

```text
Manual DI only — no container framework
createApp() still takes AppDependencies (tests keep fine-grained wiring)
No GetFlight use case yet (route still uses repository.findById)
No background jobs / Docker / message broker
Bootstrap failure still surfaces as raw uncaught stack (ops log polish later)
```
