import type { FlightSearchSort } from "../../src/flights/flight-search.js";
import { flightSearchSql } from "../../src/flights/postgres/flight-search-sql.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";

/**
 * Day 51 Step 2 — EXPLAIN (ANALYZE, BUFFERS) of the flight search on the
 * volume from generate-search-volume.ts, under three index variants:
 *   A  no index for the search (what flights has today),
 *   B  (origin_airport_id, destination_airport_id, departure_at),
 *   C  (departure_at) alone.
 *   D  B + flight_seats (flight_id, fare_class) WHERE AVAILABLE (not adopted).
 * B is what migration AddFlightSearchIndex creates; it is dropped first and
 * recreated at the end. Each variant is created, ANALYZEd, measured (7 runs,
 * median of the execution time; the first run warms the cache) and dropped.
 * Run `VACUUM (PARALLEL 0, ANALYZE) flight_seats` after seeding: the
 * volume's visibility map is otherwise empty. booking_test only.
 */

type Variant = { name: string; create: string | null };

const VARIANTS: readonly Variant[] = [
  { name: "A — no search index", create: null },
  {
    name: "B — (origin, destination, departure_at)",
    create: `CREATE INDEX "perf_flights_route_departure" ON "flights" ("origin_airport_id", "destination_airport_id", "departure_at")`,
  },
  {
    name: "D — B + flight_seats (flight_id, fare_class) WHERE AVAILABLE",
    create: `CREATE INDEX "perf_flights_route_departure" ON "flights" ("origin_airport_id", "destination_airport_id", "departure_at"); CREATE INDEX "perf_seats_available_class" ON "flight_seats" ("flight_id", "fare_class") WHERE "status" = 'AVAILABLE'`,
  },
  {
    name: "C — (departure_at)",
    create: `CREATE INDEX "perf_flights_departure" ON "flights" ("departure_at")`,
  },
];

const NOW = "2026-11-05T00:00:00Z";
const RUNS = 7;

type Query = { name: string; sort: FlightSearchSort; parameters: unknown[]; withCursor: boolean };

const QUERIES: readonly Query[] = [
  {
    name: "SGN→HAN, 3 days, 2 passengers, by departure, page 1",
    sort: "departure",
    parameters: ["SGN", "HAN", "2026-12-01", "2026-12-03", NOW, 2, 21],
    withCursor: false,
  },
  {
    name: "SGN→HAN, 3 days, 2 passengers, by price, page 1",
    sort: "price",
    parameters: ["SGN", "HAN", "2026-12-01", "2026-12-03", NOW, 2, 21],
    withCursor: false,
  },
  {
    name: "SGN→HAN, 7 days, 9 passengers, by departure, page 1",
    sort: "departure",
    parameters: ["SGN", "HAN", "2026-12-01", "2026-12-07", NOW, 9, 51],
    withCursor: false,
  },
  {
    name: "HAN→LHR, 7 days, 2 passengers (a thin route)",
    sort: "departure",
    parameters: ["HAN", "LHR", "2026-12-01", "2026-12-07", NOW, 2, 21],
    withCursor: false,
  },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function main(): Promise<void> {
  const config = parsePostgresConfig(process.env);
  if (!config.database.endsWith("_test")) {
    throw new Error(`Refusing to measure in "${config.database}"`);
  }
  const dataSource = createBookingDataSource(config);
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.query(`DROP INDEX IF EXISTS "idx_flights_route_departure"`);
  const [{ flights }] = (await dataSource.query(`SELECT count(*)::int AS "flights" FROM "flights"`)) as [{ flights: number }];
  process.stdout.write(`flights in ${config.database}: ${flights}\n`);

  for (const variant of VARIANTS) {
    if (variant.create !== null) {
      await dataSource.query(variant.create);
    }
    await dataSource.query(`ANALYZE "flights"`);
    await dataSource.query(`ANALYZE "flight_seats"`);
    process.stdout.write(`\n## ${variant.name}\n`);

    for (const query of QUERIES) {
      const sql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${flightSearchSql(query.sort, query.withCursor)}`;
      const times: number[] = [];
      let last: { plan: Record<string, unknown>; execution: number; planning: number } | undefined;
      for (let run = 0; run < RUNS; run += 1) {
        const [row] = (await dataSource.query(sql, query.parameters)) as Array<{ "QUERY PLAN": unknown }>;
        const [explained] = row?.["QUERY PLAN"] as Array<{
          Plan: Record<string, unknown>;
          "Execution Time": number;
          "Planning Time": number;
        }>;
        if (run > 0) times.push(explained!["Execution Time"]);
        last = { plan: explained!.Plan, execution: explained!["Execution Time"], planning: explained!["Planning Time"] };
      }
      const flightsAccess = findFlightsAccess(last!.plan);
      process.stdout.write(
        `- ${query.name}: median ${median(times).toFixed(2)} ms ` +
          `(planning ${last!.planning.toFixed(2)} ms), rows ${String(last!.plan["Actual Rows"])}, ` +
          `shared hit ${String(last!.plan["Shared Hit Blocks"])} read ${String(last!.plan["Shared Read Blocks"])}; ` +
          `flights via ${flightsAccess}\n`,
      );
    }

    if (variant.create !== null) {
      for (const [, name] of variant.create.matchAll(/INDEX "([^"]+)"/g)) {
        await dataSource.query(`DROP INDEX "${name}"`);
      }
    }
  }
  await dataSource.query(
    `CREATE INDEX "idx_flights_route_departure" ON "flights" ("origin_airport_id", "destination_airport_id", "departure_at")`,
  );
  await dataSource.destroy();
}

/** How the plan reaches the flights table: the node type and its index. */
function findFlightsAccess(node: Record<string, unknown>): string {
  if (node["Relation Name"] === "flights") {
    const index = node["Index Name"] === undefined ? "" : ` ${String(node["Index Name"])}`;
    return `${String(node["Node Type"])}${index} (rows removed by filter: ${String(node["Rows Removed by Filter"] ?? 0)})`;
  }
  for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) {
    const found = findFlightsAccess(child);
    if (found !== "?") return found;
  }
  return "?";
}

await main();
