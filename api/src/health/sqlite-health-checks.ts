import type { DatabaseSync } from "node:sqlite";

import type { HealthChecks, ReadinessHealth } from "./health-checks.js";

type DatabasePingRow = {
  ok: number;
};

export function createSqliteHealthChecks(database: DatabaseSync): HealthChecks {
  const pingDatabase = database.prepare(`
    SELECT 1 AS ok
  `);

  return {
    async checkReadiness(): Promise<ReadinessHealth> {
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
