import type { Logger } from "../observability/logger.js";
import type { Job, JobScheduler } from "./job-scheduler.js";

type Handle = {
  job: Job;
  timer: NodeJS.Timeout | undefined;
  stopped: boolean;
};

/**
 * In-process scheduler using recursive setTimeout (no overlap).
 * Accepts multi-instance duplicate execution — documented Day 17 limitation.
 */
export function createInMemoryJobScheduler(logger: Logger): JobScheduler {
  const handles: Handle[] = [];
  let started = false;

  function register(job: Job): void {
    handles.push({ job, timer: undefined, stopped: false });
  }

  function scheduleNext(handle: Handle): void {
    if (handle.stopped) {
      return;
    }

    handle.timer = setTimeout(async () => {
      if (handle.stopped) {
        return;
      }

      const startedAt = Date.now();
      try {
        await handle.job.handler();
        logger.info("job_completed", {
          job: handle.job.name,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        logger.error("job_failed", {
          job: handle.job.name,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Schedule the next run only after this one finishes → no overlap.
        scheduleNext(handle);
      }
    }, handle.job.intervalMs);
  }

  function start(): void {
    if (started) {
      return;
    }

    started = true;

    for (const handle of handles) {
      handle.stopped = false;
      scheduleNext(handle);
    }
  }

  function stop(): void {
    started = false;

    for (const handle of handles) {
      handle.stopped = true;
      if (handle.timer !== undefined) {
        clearTimeout(handle.timer);
        handle.timer = undefined;
      }
    }
  }

  return { register, start, stop };
}
