export interface TransactionRunner {
  run<T>(operation: () => T): T;
}
