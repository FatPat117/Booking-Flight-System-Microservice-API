import type { ExpireHolds } from "../bookings/expire-holds.js";
import type { Logger } from "../observability/logger.js";
import type { Job } from "./job-scheduler.js";

/**
 * Runs ExpireHolds on every tick (Decision 12). Quiet when nothing was due;
 * a warning when a run stopped at its batch limit, because then seats stay
 * HELD past their deadline for at least one more interval.
 */
export function createBookingHoldExpiryJob(deps: {
  expireHolds: ExpireHolds;
  logger: Logger;
  intervalMs: number;
}): Job {
  return {
    name: "booking-hold-expiry-job",
    intervalMs: deps.intervalMs,
    handler: async () => {
      const result = await deps.expireHolds();

      if (result.expired > 0) {
        deps.logger.info("booking_holds_expired", {
          expired: result.expired,
          batches: result.batches,
        });
      }

      if (result.exhausted) {
        deps.logger.warn("booking_hold_expiry_backlog", {
          expired: result.expired,
          batches: result.batches,
        });
      }
    },
  };
}
