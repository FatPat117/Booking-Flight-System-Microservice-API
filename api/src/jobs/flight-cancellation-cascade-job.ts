import type { CascadeFlightCancellations } from "../bookings/cascade-flight-cancellations.js";
import type { Logger } from "../observability/logger.js";
import type { Job } from "./job-scheduler.js";

/**
 * Runs the flight cancellation cascade on every tick (Decision 18). Quiet
 * when no cancelled flight has a live booking left; a warning when a run
 * stopped at its limit, because then some bookings of a cancelled flight
 * stay live for at least one more interval.
 */
export function createFlightCancellationCascadeJob(deps: {
  cascadeFlightCancellations: CascadeFlightCancellations;
  logger: Logger;
  intervalMs: number;
}): Job {
  return {
    name: "flight-cancellation-cascade-job",
    intervalMs: deps.intervalMs,
    handler: async () => {
      const result = await deps.cascadeFlightCancellations();

      if (result.cancelled > 0) {
        deps.logger.info("flight_cancellation_cascaded", {
          cancelled: result.cancelled,
          refundsStarted: result.refundsStarted,
        });
      }

      if (result.exhausted) {
        deps.logger.warn("flight_cancellation_cascade_backlog", {
          cancelled: result.cancelled,
        });
      }
    },
  };
}
