import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 46 — contract (3 of 3). Makes the new references required and drops
 * the old free-text columns.
 *
 * Refuses — never deletes — when a flight still has a NULL reference (the
 * Day 44 convention): the message names each flight and what is missing, so
 * the operator can register the airport, assign an aircraft, or delete
 * disposable dev data, then run migrations again. Because migrations run one
 * transaction each, expand + backfill stay applied while this one is refused.
 *
 * No index on origin/destination yet: no query filters on them until flight
 * search (phase D step 8), and an index is added with the query that needs it
 * (Day 38). The aircraft column is indexed by the exclusion constraint's GiST
 * index (next migration).
 */
export class ContractFlightReferences1790458000000 implements MigrationInterface {
  name = "ContractFlightReferences1790458000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        problems text;
      BEGIN
        SELECT string_agg(format('  %s (%s): %s', flight_number, id, reason), E'\\n')
        INTO problems
        FROM (
          SELECT flight_number, id,
                 format('origin %s is not a registered airport', origin) AS reason
          FROM flights WHERE origin_airport_id IS NULL
          UNION ALL
          SELECT flight_number, id,
                 format('destination %s is not a registered airport', destination)
          FROM flights WHERE destination_airport_id IS NULL
          UNION ALL
          SELECT flight_number, id, 'no aircraft assigned'
          FROM flights WHERE aircraft_id IS NULL
        ) AS missing;

        IF problems IS NOT NULL THEN
          RAISE EXCEPTION E'Flights still miss a required reference:\\n%', problems
            USING HINT = 'Register missing airports (POST /api/airports or npm run seed:reference), '
              || 'assign aircraft (UPDATE flights SET aircraft_id = (SELECT id FROM aircraft '
              || 'WHERE registration = ''VN-A321'') WHERE id = ''<flight id>''), '
              || 'or delete disposable dev flights, then run migrations again.';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "flights"
        ALTER COLUMN "origin_airport_id" SET NOT NULL,
        ALTER COLUMN "destination_airport_id" SET NOT NULL,
        ALTER COLUMN "aircraft_id" SET NOT NULL,
        ALTER COLUMN "status" SET NOT NULL,
        ADD CONSTRAINT "FK_flights_origin_airport_id"
          FOREIGN KEY ("origin_airport_id") REFERENCES "airports" ("id"),
        ADD CONSTRAINT "FK_flights_destination_airport_id"
          FOREIGN KEY ("destination_airport_id") REFERENCES "airports" ("id"),
        ADD CONSTRAINT "FK_flights_aircraft_id"
          FOREIGN KEY ("aircraft_id") REFERENCES "aircraft" ("id"),
        ADD CONSTRAINT "CHK_flights_status"
          CHECK ("status" IN ('SCHEDULED', 'OPEN', 'CANCELLED')),
        ADD CONSTRAINT "CHK_flights_origin_destination_airports"
          CHECK ("origin_airport_id" <> "destination_airport_id"),
        DROP CONSTRAINT "CHK_flights_origin_length",
        DROP CONSTRAINT "CHK_flights_destination_length",
        DROP CONSTRAINT "CHK_flights_origin_destination",
        DROP COLUMN "origin",
        DROP COLUMN "destination"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "flights"
        ADD COLUMN "origin" character varying,
        ADD COLUMN "destination" character varying
    `);

    await queryRunner.query(`
      UPDATE "flights" f
      SET "origin" = o."code", "destination" = d."code"
      FROM "airports" o, "airports" d
      WHERE o."id" = f."origin_airport_id" AND d."id" = f."destination_airport_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "flights"
        ALTER COLUMN "origin" SET NOT NULL,
        ALTER COLUMN "destination" SET NOT NULL,
        ADD CONSTRAINT "CHK_flights_origin_length" CHECK (length("origin") = 3),
        ADD CONSTRAINT "CHK_flights_destination_length"
          CHECK (length("destination") = 3),
        ADD CONSTRAINT "CHK_flights_origin_destination"
          CHECK ("origin" <> "destination"),
        DROP CONSTRAINT "CHK_flights_origin_destination_airports",
        DROP CONSTRAINT "CHK_flights_status",
        DROP CONSTRAINT "FK_flights_aircraft_id",
        DROP CONSTRAINT "FK_flights_destination_airport_id",
        DROP CONSTRAINT "FK_flights_origin_airport_id",
        ALTER COLUMN "status" DROP NOT NULL,
        ALTER COLUMN "aircraft_id" DROP NOT NULL,
        ALTER COLUMN "destination_airport_id" DROP NOT NULL,
        ALTER COLUMN "origin_airport_id" DROP NOT NULL
    `);
  }
}
