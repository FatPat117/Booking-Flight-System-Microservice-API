import type { FlightSearchSort } from "../flight-search.js";
import { onSaleSql } from "./on-sale-sql.js";

/**
 * One page of a flight search as one statement (Decision 17, BR-FLT-10).
 *
 * Parameters: $1 origin code, $2 destination code, $3 first local date,
 * $4 last local date (inclusive), $5 now, $6 passengers, $7 rows to fetch
 * (limit + 1). With a cursor: $8 departure_at, $9 id, and for
 * `sort = price` $10 lowest fare.
 *
 * - `bounds` turns the origin's local dates into one UTC interval from the
 *   **parameters**: `date::timestamp AT TIME ZONE zone` is local midnight as
 *   an instant, so a 23- or 25-hour DST day comes out right. `departure_at`
 *   itself is compared bare, so an index on it stays usable (sargable).
 * - `candidates` filters route, interval and the hold's sales window
 *   (onSaleSql) before any seat is read: seats are counted only for flights
 *   that can still match.
 * - `classes` starts from the flight's fares — exactly its classes
 *   (BR-FLT-09) — and counts only AVAILABLE seats of each, so a sold-out
 *   class still appears with 0 and sold seats are never read.
 * - `matched` keeps a flight when one class has room for all passengers;
 *   `lowest_fare` is the cheapest such class.
 * - Keyset: `(sort key…, id) > (cursor…)`, then `ORDER BY` the same key.
 */
export function flightSearchSql(sort: FlightSearchSort, withCursor: boolean): string {
  const orderKey =
    sort === "price"
      ? `matched."lowest_fare", matched."departure_at", matched."id"`
      : `matched."departure_at", matched."id"`;
  const cursorKey = sort === "price" ? `$10::bigint, $8::timestamptz, $9::uuid` : `$8::timestamptz, $9::uuid`;
  const after = withCursor ? `WHERE (${orderKey}) > (${cursorKey})` : "";

  return `WITH route AS (
       SELECT origin."id" AS "origin_id", origin."code" AS "origin_code",
              origin."time_zone" AS "origin_time_zone",
              destination."id" AS "destination_id", destination."code" AS "destination_code",
              destination."time_zone" AS "destination_time_zone"
       FROM "airports" origin, "airports" destination
       WHERE origin."code" = $1 AND destination."code" = $2
     ), bounds AS (
       SELECT route.*,
              ($3::date::timestamp AT TIME ZONE route."origin_time_zone") AS "starts_at",
              (($4::date + 1)::timestamp AT TIME ZONE route."origin_time_zone") AS "ends_at"
       FROM route
     ), candidates AS (
       SELECT flight."id", flight."flight_number", flight."departure_at", flight."arrival_at",
              flight."status", bounds."origin_code", bounds."origin_time_zone",
              bounds."destination_code", bounds."destination_time_zone"
       FROM bounds
       JOIN "flights" flight
         ON flight."origin_airport_id" = bounds."origin_id"
        AND flight."destination_airport_id" = bounds."destination_id"
       WHERE flight."departure_at" >= bounds."starts_at"
         AND flight."departure_at" < bounds."ends_at"
         AND ${onSaleSql("flight", "$5")}
     ), classes AS (
       SELECT fare."flight_id", fare."fare_class", fare."amount_vnd",
              (SELECT count(*)::int FROM "flight_seats" seat
               WHERE seat."flight_id" = fare."flight_id"
                 AND seat."fare_class" = fare."fare_class"
                 AND seat."status" = 'AVAILABLE') AS "available"
       FROM candidates
       JOIN "flight_fares" fare ON fare."flight_id" = candidates."id"
     ), matched AS (
       SELECT candidates.*,
              min(classes."amount_vnd") FILTER (WHERE classes."available" >= $6) AS "lowest_fare",
              json_agg(json_build_object(
                'fareClass', classes."fare_class",
                'availableSeats', classes."available",
                'amountVnd', classes."amount_vnd"::text
              ) ORDER BY classes."amount_vnd", classes."fare_class") AS "classes"
       FROM candidates
       JOIN classes ON classes."flight_id" = candidates."id"
       GROUP BY candidates."id", candidates."flight_number", candidates."departure_at",
                candidates."arrival_at", candidates."status", candidates."origin_code",
                candidates."origin_time_zone", candidates."destination_code",
                candidates."destination_time_zone"
       HAVING max(classes."available") >= $6
     )
     SELECT matched."id", matched."flight_number", matched."departure_at", matched."arrival_at",
            matched."status", matched."origin_code", matched."origin_time_zone",
            matched."destination_code", matched."destination_time_zone",
            matched."lowest_fare"::text AS "lowest_fare", matched."classes"
     FROM matched
     ${after}
     ORDER BY ${orderKey}
     LIMIT $7`;
}
