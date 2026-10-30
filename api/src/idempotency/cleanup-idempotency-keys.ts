import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { IdempotencyRepository } from "./idempotency-repository.js";

/** BR-PAY-10: a completed key answers repeats for 24 hours. */
export const IDEMPOTENCY_KEY_RETENTION_MS = 24 * 60 * 60_000;

/**
 * - deleted: keys removed in this run.
 * - exhausted: stopped at `maxBatches` with the last batch full; the next
 *   run continues.
 */
export type CleanupIdempotencyKeysResult = Readonly<{
  deleted: number;
  batches: number;
  exhausted: boolean;
}>;

export type CleanupIdempotencyKeys = () => Promise<CleanupIdempotencyKeysResult>;

type CleanupIdempotencyKeysDependencies = {
  idempotencyRepository: IdempotencyRepository;
  transactionRunner: TransactionRunner;
  getCurrentTime: () => Date;
  batchSize: number;
  maxBatches: number;
};

/**
 * One run of the key cleanup job (Decision 15, BR-PAY-10). Each batch is
 * its own short transaction. Only COMPLETED keys go; after that a repeated
 * request is a new request, and the booking's state and BR-PAY-05 — not the
 * key — refuse a second charge.
 */
export function createCleanupIdempotencyKeys(
  dependencies: CleanupIdempotencyKeysDependencies,
): CleanupIdempotencyKeys {
  const { idempotencyRepository, transactionRunner, getCurrentTime, batchSize, maxBatches } =
    dependencies;

  return async () => {
    const cutoff = new Date(getCurrentTime().getTime() - IDEMPOTENCY_KEY_RETENTION_MS);
    let deleted = 0;

    for (let batches = 1; batches <= maxBatches; batches += 1) {
      const count = await transactionRunner.run(() =>
        idempotencyRepository.deleteCompletedBefore(cutoff, batchSize),
      );
      deleted += count;

      if (count < batchSize) {
        return { deleted, batches, exhausted: false };
      }
    }

    return { deleted, batches: maxBatches, exhausted: true };
  };
}
