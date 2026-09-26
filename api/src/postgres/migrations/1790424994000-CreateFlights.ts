import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Hand-written (reviewed SQL, not TypeORM's auto-generated diff) — mirrors
 * the constraints in api/src/migrations/migrations.ts (001_create_flights),
 * translated to Postgres:
 * - TEXT dates -> TIMESTAMPTZ (Day 35 decision; see FlightEntity doc comment)
 * - SQLite STRICT -> nothing needed, Postgres columns are always typed
 * - UNIQUE(flight_number, departure_at) is what FlightRepository.create()'s
 *   "duplicate" outcome depends on (23505 unique_violation)
 */
export class CreateFlights1790424994000 implements MigrationInterface {
  name = "CreateFlights1790424994000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "flights" (
        "id" uuid NOT NULL,
        "flight_number" character varying NOT NULL,
        "origin" character varying NOT NULL,
        "destination" character varying NOT NULL,
        "departure_at" TIMESTAMPTZ NOT NULL,
        "arrival_at" TIMESTAMPTZ NOT NULL,
        "price_in_cents" integer NOT NULL,
        "currency" character varying NOT NULL,
        "available_seats" integer NOT NULL,
        CONSTRAINT "PK_flights" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_flights_flight_number_departure_at"
          UNIQUE ("flight_number", "departure_at"),
        CONSTRAINT "CHK_flights_origin_length" CHECK (length("origin") = 3),
        CONSTRAINT "CHK_flights_destination_length"
          CHECK (length("destination") = 3),
        CONSTRAINT "CHK_flights_origin_destination"
          CHECK ("origin" <> "destination"),
        CONSTRAINT "CHK_flights_arrival_after_departure"
          CHECK ("arrival_at" > "departure_at"),
        CONSTRAINT "CHK_flights_price_positive" CHECK ("price_in_cents" > 0),
        CONSTRAINT "CHK_flights_currency" CHECK ("currency" IN ('VND', 'USD')),
        CONSTRAINT "CHK_flights_seats_nonnegative"
          CHECK ("available_seats" >= 0)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "flights"`);
  }
}
