import type { FlightRepository } from "../flights/flight-repository.js";
import type { Logger } from "../observability/logger.js";
import type { Job } from "./job-scheduler.js";

/**
 * Periodically logs how many flights exist.
 *
 * Uses findPage({ limit: 1 }) so SQLite still runs COUNT(*) for totalItems
 * without loading the full table. Trade-off: one unused row is selected;
 * a dedicated count() would be cleaner at large scale — deferred until needed.
 */
export function createFlightsSummaryJob(deps: {
  flightRepository: FlightRepository;
  logger: Logger;
  intervalMs: number;
}): Job {
  return {
    name: "flights-summary-job",
    intervalMs: deps.intervalMs,
    handler: async () => {
      const page = deps.flightRepository.findPage({
        limit: 1,
        offset: 0,
      });

      deps.logger.info("flights_summary", {
        total: page.totalItems,
      });
    },
  };
}
