/**
 * A periodic task independent of any HTTP request lifecycle.
 */
export type Job = {
  /** Unique name for logs/debug — not a distributed identity */
  name: string;
  /** Delay between runs, in milliseconds */
  intervalMs: number;
  /** Job body. Scheduler must catch throws so one failure cannot crash the process */
  handler: () => Promise<void>;
};

export type JobScheduler = Readonly<{
  /** Register a job. It does not run until start() is called */
  register(job: Job): void;
  /** Start all registered jobs */
  start(): void;
  /**
   * Stop all jobs — must be called on shutdown to avoid leaking timers.
   * Resolves once every run already in progress has finished, so the caller
   * can close what the jobs use (DB, publisher) without cutting a run off
   * mid-transaction. Starts no new run.
   */
  stop(): Promise<void>;
}>;
