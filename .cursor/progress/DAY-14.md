# Day 14 — Session Notes

**Date completed:** 2026-07-21
**Theme:** Transaction Boundary for Flight + Audit Writes
**Status:** Completed

## Real pressure

```text
Day 13: flight insert OK, audit insert fail → inconsistent state
Day 14: both commit or both rollback
```

## Delivered

```text
src/transactions/transaction-runner.ts
src/transactions/sqlite-transaction-runner.ts
CreateFlight wraps flight + audit in transactionRunner.run()
index.ts wires createSqliteTransactionRunner
tests/transaction-runner.test.ts
API rollback test when audit fails
README updated
```

## Flow

```text
CreateFlight
  ↓
transactionRunner.run()
  ├── flightRepository.create()
  └── auditRecorder.record()
```

Validation stays outside transaction.

## Quality gate

```text
116 tests pass
```

## Remaining limitations

```text
Local SQLite only
No savepoints / nested transactions
No distributed transaction / outbox
```
