import type { Logger } from "../observability/logger.js";
import type { Job, JobScheduler } from "./job-scheduler.js";

type Handle = {
  job: Job;
  timer: NodeJS.Timeout | undefined;
  /** The run in progress, for stop() to wait on. Never rejects. */
  running: Promise<void> | undefined;
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
    handles.push({ job, timer: undefined, running: undefined, stopped: false });
  }

  async function runOnce(handle: Handle): Promise<void> {
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
    }
  }

  function scheduleNext(handle: Handle): void {
    if (handle.stopped) {
      return;
    }

    handle.timer = setTimeout(() => {
      handle.timer = undefined;
      if (handle.stopped) {
        return;
      }

      handle.running = runOnce(handle).finally(() => {
        handle.running = undefined;
        // Schedule the next run only after this one finishes → no overlap.
        scheduleNext(handle);
      });
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

  // Day 48B: a run of the expiry job is a database transaction. Returning
  // while one is in flight would let close() destroy the DataSource under it.
  async function stop(): Promise<void> {
    started = false;

    for (const handle of handles) {
      handle.stopped = true;
      if (handle.timer !== undefined) {
        clearTimeout(handle.timer);
        handle.timer = undefined;
      }
    }

    await Promise.all(handles.map((handle) => handle.running));
  }

  return { register, start, stop };
}
