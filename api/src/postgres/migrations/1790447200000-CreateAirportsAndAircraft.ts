import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 45 — reference data (phase D step 2). Pure additions: no existing
 * table changes, flights do not reference these yet (step 3).
 *
 * airports
 * - `id` uuid surrogate key; `code` is the unique business identifier
 *   (domain-model Decision 6: IATA codes get reassigned).
 * - `code` CHECK is the last safety net: the application upper-cases the
 *   code before saving, so the unique constraint on the normalized value is
 *   enough for "sgn" and "SGN" to collide.
 * - `time_zone` CHECK only rejects empty: Postgres does not know the IANA
 *   list, and it must not — a stored zone stays valid even if a later Node
 *   renames it (BR-REF-04, validated on write).
 *
 * aircraft
 * - `registration` unique, upper-cased by the application; the CHECK mirrors
 *   the application's format rule.
 *
 * seats (domain-model Decision 8: one row per seat)
 * - PRIMARY KEY (aircraft_id, row, letter) is BR-REF-03 enforced by the
 *   database: no two seats share a position on one aircraft. Its leading
 *   column also serves the FK, so no separate index on aircraft_id.
 * - row/letter bounds mirror BR-REF-06 and the SeatPosition value object.
 * - FK without ON DELETE (NO ACTION): there is no delete-aircraft feature,
 *   and silently cascading a layout away is never the right default.
 */
export class CreateAirportsAndAircraft1790447200000
  implements MigrationInterface
{
  name = "CreateAirportsAndAircraft1790447200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "airports" (
        "id" uuid NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "city" text NOT NULL,
        "time_zone" text NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_airports" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_airports_code" UNIQUE ("code"),
        CONSTRAINT "CHK_airports_code" CHECK ("code" ~ '^[A-Z]{3}$'),
        CONSTRAINT "CHK_airports_name" CHECK (length(trim("name")) > 0),
        CONSTRAINT "CHK_airports_city" CHECK (length(trim("city")) > 0),
        CONSTRAINT "CHK_airports_time_zone" CHECK (length("time_zone") > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "aircraft" (
        "id" uuid NOT NULL,
        "registration" text NOT NULL,
        "model" text NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_aircraft" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_aircraft_registration" UNIQUE ("registration"),
        CONSTRAINT "CHK_aircraft_registration"
          CHECK ("registration" ~ '^[A-Z0-9]{1,2}-?[A-Z0-9]{1,5}$'),
        CONSTRAINT "CHK_aircraft_model" CHECK (length(trim("model")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "seats" (
        "aircraft_id" uuid NOT NULL,
        "row" smallint NOT NULL,
        "letter" character(1) NOT NULL,
        "fare_class" text NOT NULL,
        CONSTRAINT "PK_seats" PRIMARY KEY ("aircraft_id", "row", "letter"),
        CONSTRAINT "FK_seats_aircraft_id" FOREIGN KEY ("aircraft_id")
          REFERENCES "aircraft" ("id"),
        CONSTRAINT "CHK_seats_row" CHECK ("row" BETWEEN 1 AND 99),
        CONSTRAINT "CHK_seats_letter" CHECK ("letter" ~ '^[A-K]$'),
        CONSTRAINT "CHK_seats_fare_class"
          CHECK ("fare_class" IN ('ECONOMY', 'BUSINESS'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "seats"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "aircraft"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "airports"`);
  }
}
