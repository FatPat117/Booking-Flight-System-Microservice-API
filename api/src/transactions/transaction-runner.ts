export interface TransactionRunner {
  /**
   * Day 36: always returns a Promise, even when `operation` is synchronous —
   * some repositories behind this boundary (Postgres) are inherently async,
   * so every implementation must await `operation()` before commit/rollback.
   */
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}
