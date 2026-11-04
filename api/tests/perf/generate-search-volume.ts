import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";

/**
 * Day 51 Step 2 — a realistic volume for measuring the flight search on
 * booking_test (never booking_db: `npm run perf:search:seed` preloads the
 * same *_test guard as the integration tests, and this file checks again).
 *
 * It REPLACES everything in airports, aircraft, flights and bookings. The
 * integration tests TRUNCATE those tables anyway, so the data lives until
 * the next test run.
 *
 * Shape (deterministic, no Math.random — rerunning gives the same data):
 * - 12 airports, LHR and CDG with DST;
 * - 120 aircraft in three layouts: A321 (8 business + 168 economy),
 *   A320 economy-only (180), 787 (28 business + 279 economy);
 * - each aircraft flies one leg every 26 h for 170 legs, out and back on
 *   one route: ~20 400 flights over ~6 months, ~3.9 M flight seats;
 *   SGN–HAN carries the most traffic (about 16 flights a day each way);
 * - 92 % OPEN, 4 % SCHEDULED, 4 % CANCELLED;
 * - each flight 0–100 % sold (one CONFIRMED booking owns the sold seats).
 */

const START = "2026-11-05T00:00:00Z";
const AIRCRAFT = 120;
const LEGS = 170;

const AIRPORTS: ReadonlyArray<readonly [string, string, string]> = [
  ["SGN", "Ho Chi Minh City", "Asia/Ho_Chi_Minh"],
  ["HAN", "Hanoi", "Asia/Ho_Chi_Minh"],
  ["DAD", "Da Nang", "Asia/Ho_Chi_Minh"],
  ["PQC", "Phu Quoc", "Asia/Ho_Chi_Minh"],
  ["HPH", "Hai Phong", "Asia/Ho_Chi_Minh"],
  ["CXR", "Nha Trang", "Asia/Ho_Chi_Minh"],
  ["VCA", "Can Tho", "Asia/Ho_Chi_Minh"],
  ["HUI", "Hue", "Asia/Ho_Chi_Minh"],
  ["BKK", "Bangkok", "Asia/Bangkok"],
  ["SIN", "Singapore", "Asia/Singapore"],
  ["LHR", "London", "Europe/London"],
  ["CDG", "Paris", "Europe/Paris"],
];

/** Short-haul routes, SGN–HAN repeated so it gets the most aircraft. */
const SHORT_ROUTES = [
  "SGN-HAN", "SGN-HAN", "SGN-HAN", "SGN-HAN", "SGN-HAN", "SGN-HAN", "SGN-HAN", "SGN-HAN",
  "SGN-DAD", "SGN-DAD", "HAN-DAD", "HAN-DAD", "SGN-PQC", "HAN-PQC", "SGN-HPH", "SGN-CXR",
  "HAN-CXR", "SGN-HUI", "HAN-VCA", "SGN-BKK", "HAN-BKK", "SGN-SIN", "HAN-SIN", "DAD-BKK",
];
/** Long-haul routes, flown by the 787s only. */
const LONG_ROUTES = ["SGN-LHR", "HAN-LHR", "SGN-CDG", "HAN-CDG"];

async function main(): Promise<void> {
  const config = parsePostgresConfig(process.env);
  if (!config.database.endsWith("_test")) {
    throw new Error(`Refusing to generate volume data in "${config.database}"`);
  }
  const dataSource = createBookingDataSource(config);
  await dataSource.initialize();
  await dataSource.runMigrations();
  const started = Date.now();

  await dataSource.transaction(async (manager) => {
    await manager.query(`TRUNCATE "airports", "aircraft", "flights", "bookings" CASCADE`);

    await manager.query(
      `INSERT INTO "airports" ("id", "code", "name", "city", "time_zone", "created_at")
       SELECT gen_random_uuid(), a.code, a.city || ' Airport', a.city, a.zone, now()
       FROM unnest($1::text[], $2::text[], $3::text[]) AS a(code, city, zone)`,
      [AIRPORTS.map((a) => a[0]), AIRPORTS.map((a) => a[1]), AIRPORTS.map((a) => a[2])],
    );

    // Aircraft n: n % 10 = 0 → 787 (long haul), n % 3 = 1 → A320 economy-only, else A321.
    await manager.query(
      `INSERT INTO "aircraft" ("id", "registration", "model", "created_at")
       SELECT gen_random_uuid(), 'VN-S' || lpad(n::text, 3, '0'),
              CASE WHEN n % 10 = 0 THEN '787-9' WHEN n % 3 = 1 THEN 'A320neo' ELSE 'A321' END,
              now()
       FROM generate_series(1, $1::int) AS n`,
      [AIRCRAFT],
    );

    await manager.query(
      `INSERT INTO "seats" ("aircraft_id", "row", "letter", "fare_class")
       SELECT a."id", layout."row", layout."letter", layout."fare_class"
       FROM "aircraft" a
       CROSS JOIN LATERAL (
         SELECT r AS "row", l AS "letter", CASE WHEN r <= 2 THEN 'BUSINESS' ELSE 'ECONOMY' END AS "fare_class"
         FROM generate_series(1, 30) r, unnest(CASE WHEN r <= 2 THEN '{A,C,D,F}'::text[] ELSE '{A,B,C,D,E,F}'::text[] END) l
         WHERE a."model" = 'A321'
         UNION ALL
         SELECT r, l, 'ECONOMY' FROM generate_series(1, 30) r, unnest('{A,B,C,D,E,F}'::text[]) l
         WHERE a."model" = 'A320neo'
         UNION ALL
         SELECT r, l, 'BUSINESS' FROM generate_series(1, 7) r, unnest('{A,D,G,K}'::text[]) l
         WHERE a."model" = '787-9'
         UNION ALL
         SELECT r, l, 'ECONOMY' FROM generate_series(10, 40) r, unnest('{A,B,C,D,E,F,G,H,K}'::text[]) l
         WHERE a."model" = '787-9'
       ) layout`,
    );

    // Leg k of aircraft n: out on even k, back on odd k, 26 h apart, each
    // aircraft offset by 11 minutes so departures spread over the day.
    await manager.query(
      `WITH plane AS (
         SELECT a."id", a."model", row_number() OVER (ORDER BY a."registration")::int AS n
         FROM "aircraft" a
       ), leg AS (
         SELECT plane.*, k,
                CASE WHEN plane."model" = '787-9'
                     THEN $4::text[]
                     ELSE $3::text[] END AS routes,
                $1::timestamptz + make_interval(hours => 26 * k, mins => 11 * plane.n) AS departure_at
         FROM plane, generate_series(0, $2::int - 1) AS k
       ), placed AS (
         SELECT leg.*,
                split_part(leg.routes[1 + ((CASE WHEN leg."model" = '787-9' THEN leg.n / 10 ELSE leg.n END) % array_length(leg.routes, 1))], '-', 1 + (k % 2)) AS origin,
                split_part(leg.routes[1 + ((CASE WHEN leg."model" = '787-9' THEN leg.n / 10 ELSE leg.n END) % array_length(leg.routes, 1))], '-', 2 - (k % 2)) AS destination,
                abs(hashtext(leg."id"::text || k)) % 100 AS roll
         FROM leg
       )
       INSERT INTO "flights" ("id", "flight_number", "departure_at", "arrival_at",
                              "origin_airport_id", "destination_airport_id", "aircraft_id", "status")
       SELECT gen_random_uuid(),
              'VN' || (1000 + placed.n * 10 + (k % 10))::text,
              date_trunc('minute', placed.departure_at),
              date_trunc('minute', placed.departure_at)
                + CASE WHEN placed."model" = '787-9' THEN interval '12 hours' ELSE interval '2 hours' END,
              o."id", d."id", placed."id",
              CASE WHEN placed.roll < 4 THEN 'SCHEDULED' WHEN placed.roll < 8 THEN 'CANCELLED' ELSE 'OPEN' END
       FROM placed
       JOIN "airports" o ON o."code" = placed.origin
       JOIN "airports" d ON d."code" = placed.destination`,
      [START, LEGS, SHORT_ROUTES, LONG_ROUTES],
    );

    await manager.query(
      `INSERT INTO "flight_fares" ("flight_id", "fare_class", "amount_vnd")
       SELECT f."id", c."fare_class",
              CASE WHEN c."fare_class" = 'BUSINESS'
                   THEN (900 + abs(hashtext(f."id"::text)) % 2100) * 1000 * 3
                   ELSE (900 + abs(hashtext(f."id"::text)) % 2100) * 1000 END
       FROM "flights" f
       JOIN (SELECT DISTINCT "aircraft_id", "fare_class" FROM "seats") c ON c."aircraft_id" = f."aircraft_id"`,
    );

    await manager.query(
      `INSERT INTO "flight_seats" ("flight_id", "row", "letter", "fare_class", "status", "booking_id")
       SELECT f."id", s."row", s."letter", s."fare_class", 'AVAILABLE', NULL
       FROM "flights" f JOIN "seats" s ON s."aircraft_id" = f."aircraft_id"`,
    );

    // One CONFIRMED booking per flight with sales; it owns the sold seats.
    // References: 6 characters from the booking alphabet, from the row number.
    await manager.query(
      `WITH sold AS (
         SELECT f."id" AS "flight_id", row_number() OVER (ORDER BY f."id") AS n
         FROM "flights" f WHERE f."status" <> 'CANCELLED'
       )
       INSERT INTO "bookings" ("id", "flight_id", "created_at", "status", "owner_account_id", "hold_expires_at", "reference")
       SELECT gen_random_uuid(), sold."flight_id", now(), 'CONFIRMED',
              '22222222-2222-4222-8222-222222222222', NULL,
              (SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + ((sold.n / (32 ^ i)::bigint) % 32)::int, 1), '' ORDER BY i)
               FROM generate_series(0, 5) AS i)
       FROM sold`,
    );

    // Flight f is sold to `fill` % (0–100); seat s is sold when its own roll is below it.
    await manager.query(
      `UPDATE "flight_seats" seat
       SET "status" = 'BOOKED', "booking_id" = booking."id"
       FROM "bookings" booking
       WHERE booking."flight_id" = seat."flight_id"
         AND abs(hashtext(seat."flight_id"::text || seat."row" || seat."letter")) % 100
             < abs(hashtext(seat."flight_id"::text || 'fill')) % 101`,
    );
  });

  await dataSource.query("ANALYZE");
  const [counts] = (await dataSource.query(
    `SELECT (SELECT count(*) FROM "flights")::int AS "flights",
            (SELECT count(*) FROM "flight_seats")::int AS "seats",
            (SELECT count(*) FROM "flight_seats" WHERE "status" = 'BOOKED')::int AS "booked",
            pg_size_pretty(pg_total_relation_size('flight_seats')) AS "seatsSize"`,
  )) as Array<Record<string, unknown>>;
  process.stdout.write(`${JSON.stringify({ ...counts, seconds: (Date.now() - started) / 1000 })}\n`);
  await dataSource.destroy();
}

await main();
