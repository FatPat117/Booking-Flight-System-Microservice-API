import type { DataSource } from "typeorm";

import type { HealthChecks, ReadinessHealth } from "../health-checks.js";

/**
 * Deliberately queries dataSource.query() directly (the pool's default
 * connection), never resolveEntityManager() — readiness must reflect
 * whether the pool itself can serve a query right now, not whether some
 * unrelated transaction happens to be open (Day 40).
 */
export function createPostgresHealthChecks(dataSource: DataSource): HealthChecks {
  return {
    async checkReadiness(): Promise<ReadinessHealth> {
      try {
        const rows = (await dataSource.query("SELECT 1 AS ok")) as Array<{
          ok: number;
        }>;

        if (rows[0]?.ok === 1) {
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
