import type { DataSource } from "typeorm";

import {
  isInTransaction,
  runWithTransactionManager,
} from "../postgres/transaction-context.js";
import type { TransactionRunner } from "./transaction-runner.js";

/**
 * dataSource.transaction() does not detect nesting on its own — called from
 * `dataSource` (not an already-bound transactional EntityManager) it always
 * opens a brand new connection from the pool, so a silent nested call would
 * commit/rollback on a second, unrelated connection instead of the outer
 * transaction — breaking atomicity rather than nesting it. Fail loudly here
 * instead, the same way requireAuthenticatedUser fails loudly when there is
 * no active request context.
 */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      "PostgresTransactionRunner.run() was called from inside an already-open " +
        "transaction. Nested transactions are not supported: only the outermost " +
        "caller should call transactionRunner.run().",
    );
    this.name = "NestedTransactionError";
  }
}

/**
 * Unlike SqliteTransactionRunner, no promise queue: Postgres borrows a
 * separate connection per transaction from the pool, so concurrent
 * transactions are the normal case. Correctness under contention still comes
 * from OCC (conditional UPDATE, ADR-004), not from serializing on one
 * connection like SQLite has to.
 *
 * dataSource.transaction() (EntityManager.transaction under the hood) already
 * does createQueryRunner -> startTransaction -> run callback ->
 * commitTransaction on success / rollbackTransaction on throw -> release in a
 * finally, unconditionally — no manual try/finally needed here.
 */
export function createPostgresTransactionRunner(
  dataSource: DataSource,
): TransactionRunner {
  return {
    async run<T>(operation: () => T | Promise<T>): Promise<T> {
      if (isInTransaction()) {
        throw new NestedTransactionError();
      }

      return dataSource.transaction((manager) =>
        runWithTransactionManager(manager, async () => operation()),
      );
    },
  };
}
