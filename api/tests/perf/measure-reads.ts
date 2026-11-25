import { performance } from "node:perf_hooks";

import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createGetFlightSeatMap } from "../../src/flights/get-flight-seat-map.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresFlightSearch } from "../../src/flights/postgres/postgres-flight-search.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresAdminReports } from "../../src/reports/postgres/postgres-admin-reports.js";

/**
 * Day 53 Step 5 — the read-side evidence table for the Day 54 retrospective.
 * Every meaningful read, through the adapter production uses, on the volume
 * of perf:search:seed + perf:reports:seed (booking_test only). Per read: one
 * warm-up, then 7 runs; the median and the worst of the 7, wall time in this
 * process (driver and mapping included, no HTTP); the statements it sends,
 * counted by the DataSource's query logger (transaction control excluded).
 * One client, no concurrent load.
 */

const RUNS = 7;
const NOW = new Date("2026-11-05T00:00:00Z");

async function main(): Promise<void> {
  const config = parsePostgresConfig(process.env);
  if (!config.database.endsWith("_test")) {
    throw new Error(`Refusing to measure in "${config.database}"`);
  }
  const statements: string[] = [];
  const dataSource = createBookingDataSource(config);
  dataSource.setOptions({
    logging: ["query"],
    logger: {
      logQuery: (query) => void statements.push(query),
      logQueryError: () => {},
      logQuerySlow: () => {},
      logSchemaBuild: () => {},
      logMigration: () => {},
      log: () => {},
    },
  });
  await dataSource.initialize();

  const [sample] = (await dataSource.query(
    `SELECT
       (SELECT "flight_id" FROM "flight_seats" WHERE "status" = 'BOOKED'
        GROUP BY "flight_id" ORDER BY count(*) DESC, "flight_id" LIMIT 1) AS "full_flight",
       (SELECT "owner_account_id" FROM "bookings"
        GROUP BY "owner_account_id" ORDER BY count(*) DESC LIMIT 1) AS "busiest_owner",
       (SELECT count(*) FROM "bookings")::int AS "bookings",
       (SELECT "target_id" FROM "audit_logs" WHERE "target_type" = 'booking'
        GROUP BY "target_id" ORDER BY count(*) DESC, "target_id" LIMIT 1) AS "busiest_booking"`,
  )) as Array<{ full_flight: string; busiest_owner: string; bookings: number; busiest_booking: string }>;
  if (sample === undefined || sample.full_flight === null) throw new Error("Seed the volume first");

  const flightSearch = createPostgresFlightSearch(dataSource);
  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const reports = createPostgresAdminReports(dataSource);
  const seatMap = createGetFlightSeatMap({ flightRepository });

  const reads: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: "search SGN→HAN, 3 days, 2 pax, page 20",
      run: () =>
        flightSearch.search(
          { origin: "SGN", destination: "HAN", departureDateFrom: "2026-12-01", departureDateTo: "2026-12-03", passengers: 2, sort: "departure", limit: 20 },
          NOW,
        ),
    },
    { name: "flight details (fullest flight)", run: () => flightSearch.findDetails(sample.full_flight) },
    { name: "seat map (fullest flight)", run: () => seatMap(sample.full_flight) },
    {
      name: `my bookings, page 20 (owner of ${sample.bookings} bookings)`,
      run: () => bookingRepository.findPage({ kind: "owner", accountId: sample.busiest_owner }, { limit: 20, offset: 0 }),
    },
    { name: "manifest (fullest flight)", run: () => reports.findManifest(sample.full_flight, NOW) },
    {
      name: "load factor, 31 days, page 50",
      run: () => reports.loadFactor({ dateFrom: "2026-12-01", dateTo: "2026-12-31", limit: 50 }, NOW),
    },
    {
      name: "audit log, one booking, page 50",
      run: () => reports.auditLog({ target: { type: "booking", id: sample.busiest_booking }, limit: 50 }),
    },
    {
      name: "audit log, 1-day range, page 100",
      run: () => reports.auditLog({ range: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }, limit: 100 }),
    },
  ];

  const isControl = (query: string) => /^(START TRANSACTION|SET TRANSACTION|COMMIT|ROLLBACK)/.test(query.trim());
  const rows = [];
  for (const read of reads) {
    await read.run();
    const times: number[] = [];
    let count = 0;
    for (let run = 0; run < RUNS; run += 1) {
      statements.length = 0;
      const started = performance.now();
      await read.run();
      times.push(performance.now() - started);
      count = statements.filter((query) => !isControl(query)).length;
    }
    times.sort((a, b) => a - b);
    rows.push({
      read: read.name,
      statements: count,
      medianMs: Number(times[Math.floor(RUNS / 2)]!.toFixed(2)),
      worstMs: Number(times[RUNS - 1]!.toFixed(2)),
    });
  }
  console.table(rows);
  await dataSource.destroy();
}

await main();
