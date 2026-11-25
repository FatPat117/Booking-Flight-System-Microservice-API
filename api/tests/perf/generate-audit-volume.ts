import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";

/**
 * Day 53 Step 2 — an audit log large enough for an index to matter, on
 * booking_test only (`npm run perf:reports:seed` preloads the *_test guard,
 * and this file checks again). Run after `perf:search:seed`: the entries
 * point at its flights and bookings.
 *
 * It REPLACES everything in audit_logs. Shape (deterministic):
 * - 300 000 entries, one every 52 s from 2026-06-01 (about 180 days),
 *   whole milliseconds like the application writes;
 * - 60 % about a booking, 30 % about a flight, 10 % about a payment;
 * - actions that fit the target; 1 in 5 by a system actor, the rest by 500
 *   accounts.
 */

const ENTRIES = 300_000;

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
    await manager.query(`DELETE FROM "audit_logs"`);
    await manager.query(
      `WITH bookings AS (
         SELECT "id", row_number() OVER (ORDER BY "id") AS "n" FROM "bookings"
       ),
       flights AS (
         SELECT "id", row_number() OVER (ORDER BY "id") AS "n" FROM "flights"
       ),
       counts AS (
         SELECT (SELECT count(*) FROM bookings) AS "bookings", (SELECT count(*) FROM flights) AS "flights"
       ),
       entries AS (
         SELECT i,
                CASE WHEN i % 10 < 6 THEN 'booking' WHEN i % 10 < 9 THEN 'flight' ELSE 'payment' END AS "target_type"
         FROM generate_series(1, $1::int) AS i
       )
       INSERT INTO "audit_logs"
         ("id", "action", "actor_type", "actor_id", "target_type", "target_id", "request_id", "occurred_at", "metadata")
       SELECT gen_random_uuid(),
              CASE entries."target_type"
                WHEN 'booking' THEN (ARRAY['BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_SEAT_CHANGED', 'BOOKING_CANCELLED'])[1 + i % 4]
                WHEN 'flight' THEN (ARRAY['FLIGHT_CREATED', 'FLIGHT_OPENED', 'FLIGHT_MANIFEST_VIEWED', 'FLIGHT_CANCELLED'])[1 + i % 4]
                ELSE (ARRAY['PAYMENT_REFUND_PENDING', 'PAYMENT_REFUNDED'])[1 + i % 2]
              END,
              CASE WHEN i % 5 = 0 THEN 'system' ELSE 'account' END,
              CASE WHEN i % 5 = 0 THEN 'booking-expiry'
                   ELSE '00000000-0000-4000-8000-' || lpad((i % 500)::text, 12, '0') END,
              entries."target_type",
              CASE entries."target_type"
                WHEN 'booking' THEN b."id"::text
                WHEN 'flight' THEN f."id"::text
                ELSE md5(i::text)::uuid::text
              END,
              NULL,
              timestamptz '2026-06-01T00:00:00Z' + i * interval '52 seconds' + (i % 1000) * interval '1 millisecond',
              '{}'::jsonb
       FROM entries
       CROSS JOIN counts
       LEFT JOIN bookings b ON b."n" = 1 + entries.i % counts."bookings"
       LEFT JOIN flights f ON f."n" = 1 + entries.i % counts."flights"`,
      [ENTRIES],
    );
  });

  await dataSource.query(`ANALYZE "audit_logs"`);
  const [counts] = (await dataSource.query(
    `SELECT count(*)::int AS "entries", count(DISTINCT "target_id")::int AS "targets",
            pg_size_pretty(pg_total_relation_size('audit_logs')) AS "size"
     FROM "audit_logs"`,
  )) as Array<Record<string, unknown>>;
  process.stdout.write(`${JSON.stringify({ ...counts, seconds: (Date.now() - started) / 1000 })}\n`);
  await dataSource.destroy();
}

await main();
