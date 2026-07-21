import type { DatabaseSync } from "node:sqlite";

import type { TransactionRunner } from "./transaction-runner.js";

export function createSqliteTransactionRunner(
  database: DatabaseSync,
): TransactionRunner {
  return {
    run<T>(operation: () => T): T {
      database.exec("BEGIN IMMEDIATE");

      try {
        const result = operation();

        database.exec("COMMIT");

        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Do not hide the original operation error.
        }

        throw error;
      }
    },
  };
}
