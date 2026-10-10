import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 46 — BR-FLT-03 + BR-FLT-08 in the database: an aircraft never has two
 * non-cancelled flights whose occupancy windows overlap.
 *
 * Why a constraint and not a SELECT before INSERT: two admins scheduling the
 * same aircraft concurrently would both SELECT "no overlap" and both INSERT
 * (the Day 39 race). A conditional UPDATE cannot help — there is no row to
 * update yet. An exclusion constraint is checked by the index itself, under
 * concurrency; a violation is SQLSTATE 23P01.
 *
 * btree_gist: lets a GiST index use `=` on uuid next to `&&` on ranges. It
 * is a *trusted* extension (PG13+), so the database owner (role `booking`,
 * not a superuser — Day 42) may create it. No superuser, no init script.
 *
 * flight_aircraft_occupancy(): the window is [departure, arrival + 45 min),
 * half-open — a flight landing 10:00 frees the aircraft at 10:45 and a
 * departure at exactly 10:45 is accepted (BR-FLT-08). Index expressions must
 * be IMMUTABLE, and `timestamptz + interval` is only STABLE because an
 * interval with days or months depends on the session time zone (DST). A
 * fixed number of minutes does not, so declaring this wrapper IMMUTABLE is
 * truthful. Changing the turnaround means replacing the function *and*
 * rebuilding the constraint.
 *
 * WHERE status <> 'CANCELLED': a cancelled flight frees its aircraft.
 */
export class AddAircraftScheduleExclusion1790461600000
  implements MigrationInterface
{
  name = "AddAircraftScheduleExclusion1790461600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    await queryRunner.query(`
      CREATE FUNCTION flight_aircraft_occupancy(
        departure_at timestamptz,
        arrival_at timestamptz
      ) RETURNS tstzrange
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      RETURN tstzrange(departure_at, arrival_at + interval '45 minutes', '[)')
    `);

    await queryRunner.query(`
      ALTER TABLE "flights"
        ADD CONSTRAINT "EXCL_flights_aircraft_schedule"
        EXCLUDE USING gist (
          "aircraft_id" WITH =,
          flight_aircraft_occupancy("departure_at", "arrival_at") WITH &&
        )
        WHERE ("status" <> 'CANCELLED')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "flights"
        DROP CONSTRAINT IF EXISTS "EXCL_flights_aircraft_schedule"
    `);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS flight_aircraft_occupancy(timestamptz, timestamptz)`,
    );
    await queryRunner.query(`DROP EXTENSION IF EXISTS btree_gist`);
  }
}
