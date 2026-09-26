import type { DatabaseSync } from "node:sqlite";

import type { TransactionRunner } from "./transaction-runner.js";

export function createSqliteTransactionRunner(
  database: DatabaseSync,
): TransactionRunner {
  // node:sqlite is a single, synchronous connection — it cannot have two
  // transactions open at once. Before Day 36, `run` never awaited anything,
  // so BEGIN..COMMIT always finished in one synchronous slice and two
  // concurrent callers could never interleave. Making `run` async (so a
  // Postgres implementation of the same port can await real I/O) removed
  // that guarantee: `await operation()` yields at least one microtask tick
  // even when `operation` is fully synchronous, which is enough for a
  // second `run()` call to slip in and BEGIN before the first COMMITs.
  // This queue serializes transactions on this connection explicitly
  // instead of relying on synchronous run-to-completion by accident.
  let queue: Promise<void> = Promise.resolve();

  return {
    run<T>(operation: () => T | Promise<T>): Promise<T> {
      const result = queue.then(async () => {
        database.exec("BEGIN IMMEDIATE");

        try {
          const value = await operation();

          database.exec("COMMIT");

          return value;
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // Do not hide the original operation error.
          }

          throw error;
        }
      });

      // Keep the queue moving whether this transaction committed or rolled
      // back; swallow here so a failed transaction doesn't turn `queue`
      // itself into an unhandled rejection — the real error still surfaces
      // to this call's own caller via `result`.
      queue = result.then(
        () => undefined,
        () => undefined,
      );

      return result;
    },
  };
}
