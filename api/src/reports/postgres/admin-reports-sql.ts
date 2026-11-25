/**
 * The SQL of the admin reports (Decision 19). Explicit column lists only:
 * a report returns what it names, never a row as stored.
 */

/**
 * Seats of the given flights, per class, counted in one pass. A HELD seat
 * counts as held only while its booking's hold is valid at `now`; after that
 * it is available (Decision 12), so available + held + booked = total.
 * `available` is counted on its own, not derived, so a test of that sum
 * means something.
 */
function classCountsSql(flightIds: string, now: string): string {
  return `SELECT seat."flight_id", seat."fare_class",
                 count(*)::int AS "total",
                 count(*) FILTER (WHERE seat."status" = 'BOOKED')::int AS "booked",
                 count(*) FILTER (WHERE seat."status" = 'HELD'
                                    AND booking."hold_expires_at" > ${now})::int AS "held",
                 count(*) FILTER (WHERE seat."status" = 'AVAILABLE'
                                    OR (seat."status" = 'HELD'
                                        AND booking."hold_expires_at" <= ${now}))::int AS "available"
          FROM "flight_seats" seat
          LEFT JOIN "bookings" booking
            ON booking."id" = seat."booking_id" AND seat."status" = 'HELD'
          WHERE seat."flight_id" IN (${flightIds})
          GROUP BY seat."flight_id", seat."fare_class"`;
}

function classesJson(flightId: string): string {
  return `coalesce((
           SELECT json_agg(json_build_object(
                    'fareClass', counts."fare_class", 'total', counts."total", 'booked', counts."booked",
                    'held', counts."held", 'available', counts."available"
                  ) ORDER BY counts."fare_class")
           FROM counts WHERE counts."flight_id" = ${flightId}
         ), '[]') AS "classes"`;
}

const FLIGHT_COLUMNS = `flight."id", flight."flight_number", flight."departure_at", flight."status",
         origin."code" AS "origin_code", origin."time_zone" AS "origin_time_zone",
         destination."code" AS "destination_code"`;

/** Manifest, statement 1 of 2: the flight, its seats per class, its held bookings. $1 flight, $2 now. */
export const MANIFEST_FLIGHT_SQL = `WITH counts AS (${classCountsSql("$1::uuid", "$2")})
  SELECT ${FLIGHT_COLUMNS},
         ${classesJson(`flight."id"`)},
         (SELECT count(*)::int FROM "bookings" held
          WHERE held."flight_id" = flight."id" AND held."status" = 'HELD'
            AND held."hold_expires_at" > $2) AS "held_bookings"
  FROM "flights" flight
  JOIN "airports" origin ON origin."id" = flight."origin_airport_id"
  JOIN "airports" destination ON destination."id" = flight."destination_airport_id"
  WHERE flight."id" = $1`;

/**
 * Manifest, statement 2 of 2: the CONFIRMED passengers in seat order, with
 * the four fields boarding needs (Decision 19). $1 flight.
 */
export const MANIFEST_PASSENGERS_SQL = `SELECT booking."reference", passenger."name",
         passenger."seat_row", passenger."seat_letter", passenger."fare_class"
  FROM "bookings" booking
  JOIN "booking_passengers" passenger ON passenger."booking_id" = booking."id"
  WHERE booking."flight_id" = $1 AND booking."status" = 'CONFIRMED'
  ORDER BY passenger."seat_row", passenger."seat_letter", booking."reference"`;

/**
 * Load factor, one statement per page. Every origin has its own zone, so
 * `departure_at` is first compared with one interval wide enough for every
 * zone (local midnight of dateFrom at UTC+14 to local midnight after dateTo
 * at UTC−12), which idx_flights_departure serves; then each flight's own
 * local date decides. Seats are counted for the whole page at once.
 *
 * $1 dateFrom, $2 dateTo, $3 origin code or null, $4 limit + 1, $5 now,
 * then optionally $6/$7 the key to continue after.
 */
export function loadFactorSql(after: boolean): string {
  return `WITH page AS (
    SELECT ${FLIGHT_COLUMNS}
    FROM "flights" flight
    JOIN "airports" origin ON origin."id" = flight."origin_airport_id"
    JOIN "airports" destination ON destination."id" = flight."destination_airport_id"
    WHERE flight."departure_at" >= ($1::date::timestamp - interval '14 hours') AT TIME ZONE 'UTC'
      AND flight."departure_at" < (($2::date + 1)::timestamp + interval '12 hours') AT TIME ZONE 'UTC'
      AND (flight."departure_at" AT TIME ZONE origin."time_zone")::date BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR origin."code" = $3)
      ${after ? `AND (flight."departure_at", flight."id") > ($6::timestamptz, $7::uuid)` : ""}
    ORDER BY flight."departure_at", flight."id"
    LIMIT $4
  ),
  counts AS (${classCountsSql(`SELECT "id" FROM page`, "$5")})
  SELECT page."id", page."flight_number", page."departure_at", page."status",
         page."origin_code", page."origin_time_zone", page."destination_code",
         ${classesJson(`page."id"`)}
  FROM page
  ORDER BY page."departure_at", page."id"`;
}

const AUDIT_COLUMNS = `"id", "action", "actor_type", "actor_id", "target_type", "target_id",
         "request_id", "occurred_at", "metadata"`;

export type AuditLogFilter = Readonly<{
  target?: Readonly<{ type: string; id: string }>;
  range?: Readonly<{ from: string; to: string }>;
  actorType?: string;
  actorId?: string;
  action?: string;
  after?: Readonly<{ at: string; id: string }>;
  limit: number;
}>;

/**
 * The audit page, newest first, one statement fetching `limit + 1` rows.
 * The conditions follow the two indexes (Decision 19): target then time,
 * or time alone; actor and action narrow what those find.
 */
export function auditLogSql(filter: AuditLogFilter): { sql: string; parameters: unknown[] } {
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  const add = (condition: (parameter: string) => string, value: unknown) => {
    parameters.push(value);
    conditions.push(condition(`$${parameters.length}`));
  };

  if (filter.target !== undefined) {
    add((p) => `"target_type" = ${p}`, filter.target.type);
    add((p) => `"target_id" = ${p}`, filter.target.id);
  }
  if (filter.range !== undefined) {
    add((p) => `"occurred_at" >= ${p}::timestamptz`, filter.range.from);
    add((p) => `"occurred_at" < ${p}::timestamptz`, filter.range.to);
  }
  if (filter.actorType !== undefined) add((p) => `"actor_type" = ${p}`, filter.actorType);
  if (filter.actorId !== undefined) add((p) => `"actor_id" = ${p}`, filter.actorId);
  if (filter.action !== undefined) add((p) => `"action" = ${p}`, filter.action);
  if (filter.after !== undefined) {
    parameters.push(filter.after.at, filter.after.id);
    conditions.push(
      `("occurred_at", "id") < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`,
    );
  }
  parameters.push(filter.limit + 1);

  return {
    sql: `SELECT ${AUDIT_COLUMNS}
  FROM "audit_logs"
  WHERE ${conditions.length === 0 ? "true" : conditions.join("\n    AND ")}
  ORDER BY "occurred_at" DESC, "id" DESC
  LIMIT $${parameters.length}`,
    parameters,
  };
}
