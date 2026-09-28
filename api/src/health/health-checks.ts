export type HealthStatus = "ok" | "unavailable";

export type DependencyHealth = {
  status: HealthStatus;
};

export type ReadinessHealth = {
  status: HealthStatus;
  checks: {
    database: DependencyHealth;
  };
};

/**
 * Port only — must not know whether the database behind it is node:sqlite
 * or Postgres. checkReadiness() is async even though the SQLite
 * implementation could answer synchronously, so swapping implementations
 * never changes this interface (Day 40 — the same rule already applied to
 * every repository port).
 */
export type HealthChecks = {
  checkReadiness(): Promise<ReadinessHealth>;
};
