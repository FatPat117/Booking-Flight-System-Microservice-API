import type { DatabaseSync } from "node:sqlite";

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

export type HealthChecks = {
  checkReadiness(): ReadinessHealth;
};

type DatabasePingRow = {
  ok: number;
};

export function createHealthChecks(database: DatabaseSync): HealthChecks {
  const pingDatabase = database.prepare(`
    SELECT 1 AS ok
  `);

  return {
    checkReadiness(): ReadinessHealth {
      try {
        const row = pingDatabase.get() as DatabasePingRow | undefined;

        if (row?.ok === 1) {
          return {
            status: "ok",
            checks: {
              database: {
                status: "ok",
              },
            },
          };
        }

        return {
          status: "unavailable",
          checks: {
            database: {
              status: "unavailable",
            },
          },
        };
      } catch {
        return {
          status: "unavailable",
          checks: {
            database: {
              status: "unavailable",
            },
          },
        };
      }
    },
  };
}
