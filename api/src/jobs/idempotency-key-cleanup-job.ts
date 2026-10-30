import type { CleanupIdempotencyKeys } from "../idempotency/cleanup-idempotency-keys.js";
import type { Logger } from "../observability/logger.js";
import type { Job } from "./job-scheduler.js";

/**
 * Runs CleanupIdempotencyKeys on every tick (BR-PAY-10). Quiet when nothing
 * had expired; a warning when a run stopped at its batch limit.
 */
export function createIdempotencyKeyCleanupJob(deps: {
  cleanupIdempotencyKeys: CleanupIdempotencyKeys;
  logger: Logger;
  intervalMs: number;
}): Job {
  return {
    name: "idempotency-key-cleanup-job",
    intervalMs: deps.intervalMs,
    handler: async () => {
      const result = await deps.cleanupIdempotencyKeys();

      if (result.deleted > 0) {
        deps.logger.info("idempotency_keys_deleted", {
          deleted: result.deleted,
          batches: result.batches,
        });
      }

      if (result.exhausted) {
        deps.logger.warn("idempotency_key_cleanup_backlog", {
          deleted: result.deleted,
          batches: result.batches,
        });
      }
    },
  };
}
