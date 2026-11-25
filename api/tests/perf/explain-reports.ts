import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import {
  MANIFEST_FLIGHT_SQL,
  MANIFEST_PASSENGERS_SQL,
  auditLogSql,
  loadFactorSql,
} from "../../src/reports/postgres/admin-reports-sql.js";

/**
 * Day 53 Step 2 — EXPLAIN (ANALYZE, BUFFERS) of the three admin reports,
 * with the adapter's own SQL, on the volume of perf:search:seed and
 * perf:reports:seed. Run once before AddReportIndexes and once after
 * (the label is the first argument). Each query: 7 runs, the first warms the
 * cache, the median execution time of the other 6, the buffers and the
 * index names of the last plan. One client, no concurrent load.
 */

const RUNS = 7;
const NOW = "2026-11-05T00:00:00Z";

type Query = { name: string; sql: string; parameters: unknown[] };

async function main(): Promise<void> {
  const label = process.argv[2] ?? "run";
  const config = parsePostgresConfig(process.env);
  if (!config.database.endsWith("_test")) {
    throw new Error(`Refusing to measure in "${config.database}"`);
  }
  const dataSource = createBookingDataSource(config);
  await dataSource.initialize();

  // The busiest booking and flight in the audit log, and the fullest flight.
  const [busiest] = (await dataSource.query(
    `SELECT
       (SELECT "target_id" FROM "audit_logs" WHERE "target_type" = 'booking'
        GROUP BY "target_id" ORDER BY count(*) DESC, "target_id" LIMIT 1) AS "booking",
       (SELECT "target_id" FROM "audit_logs" WHERE "target_type" = 'flight'
        GROUP BY "target_id" ORDER BY count(*) DESC, "target_id" LIMIT 1) AS "flight",
       (SELECT "flight_id" FROM "flight_seats" WHERE "status" = 'BOOKED'
        GROUP BY "flight_id" ORDER BY count(*) DESC, "flight_id" LIMIT 1) AS "full_flight"`,
  )) as Array<{ booking: string; flight: string; full_flight: string }>;
  if (busiest === undefined) throw new Error("Seed the volume first");

  const audit = (name: string, filter: Parameters<typeof auditLogSql>[0]): Query => ({
    name,
    ...(({ sql, parameters }) => ({ sql, parameters }))(auditLogSql(filter)),
  });

  const queries: Query[] = [
    audit("audit: one booking (target), page of 50", {
      target: { type: "booking", id: busiest.booking }, limit: 50,
    }),
    audit("audit: one flight + action FLIGHT_OPENED", {
      target: { type: "flight", id: busiest.flight }, action: "FLIGHT_OPENED", limit: 50,
    }),
    audit("audit: range 1 day, page of 100", {
      range: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }, limit: 100,
    }),
    audit("audit: range 31 days + one account, page of 100", {
      range: { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
      actorType: "account", actorId: "00000000-0000-4000-8000-000000000042", limit: 100,
    }),
    {
      name: "load factor: 31 days, all routes, page of 50",
      sql: loadFactorSql(false),
      parameters: ["2026-12-01", "2026-12-31", null, 51, NOW],
    },
    {
      name: "load factor: 31 days, origin SGN, page of 50",
      sql: loadFactorSql(false),
      parameters: ["2026-12-01", "2026-12-31", "SGN", 51, NOW],
    },
    { name: "manifest 1/2: flight + seats per class", sql: MANIFEST_FLIGHT_SQL, parameters: [busiest.full_flight, NOW] },
    { name: "manifest 2/2: passengers", sql: MANIFEST_PASSENGERS_SQL, parameters: [busiest.full_flight] },
  ];

  const results = [];
  for (const query of queries) {
    const times: number[] = [];
    let plan = "";
    for (let run = 0; run < RUNS; run += 1) {
      const rows = (await dataSource.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query.sql}`,
        query.parameters,
      )) as Array<{ "QUERY PLAN": string }>;
      plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
      const execution = /Execution Time: ([\d.]+) ms/.exec(plan);
      if (run > 0 && execution?.[1] !== undefined) times.push(Number(execution[1]));
    }
    times.sort((a, b) => a - b);
    const buffers = /Buffers: shared hit=(\d+)(?: read=(\d+))?/.exec(plan);
    results.push({
      label,
      query: query.name,
      medianMs: times[Math.floor(times.length / 2)],
      sharedHit: Number(buffers?.[1] ?? 0),
      read: Number(buffers?.[2] ?? 0),
      indexes: [...new Set([...plan.matchAll(/using "?([\w]+)"?/g)].map((match) => match[1]))].join(", "),
      seqScans: [...new Set([...plan.matchAll(/Seq Scan on "?(\w+)"?/g)].map((match) => match[1]))].join(", "),
    });
  }
  console.table(results);
  await dataSource.destroy();
}

await main();
