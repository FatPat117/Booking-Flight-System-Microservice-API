import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 49A — expand (1 of 4). A flight's price per fare class (domain-model
 * Decision 13). Pure addition: `flights.price_in_cents` stays until the
 * contract step.
 *
 * - One row per (flight, fare class), not price columns on `flights`: an
 *   economy-only aircraft needs no NULL column, and the hold joins a seat's
 *   `fare_class` to its price by the same key.
 * - amount_vnd is whole đồng (never ×100) as bigint: a total of nine
 *   business seats must never be a question of integer overflow. `pg` hands
 *   it to TypeScript as a string; the adapter parses it (parseVndFromDatabase).
 *   CHK_flight_fares_amount_safe caps it at 2^53 − 1, the largest integer a
 *   JS number holds exactly: a larger value would be stored, then make the
 *   flight unreadable. Refused on write instead.
 * - BR-FLT-09 (fares cover exactly the classes the aircraft has seats in)
 *   cannot be declared here — "a fare row exists for every class in
 *   flight_seats" is not a constraint. CreateFlight keeps it; the contract
 *   step checks existing data.
 * - The primary key's leading column serves FK_flight_fares_flight_id and the
 *   per-flight read (and `FOR SHARE` lock) of a hold.
 */
export class CreateFlightFares1790497600000 implements MigrationInterface {
  name = "CreateFlightFares1790497600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "flight_fares" (
        "flight_id" uuid NOT NULL,
        "fare_class" text NOT NULL,
        "amount_vnd" bigint NOT NULL,
        CONSTRAINT "PK_flight_fares" PRIMARY KEY ("flight_id", "fare_class"),
        CONSTRAINT "FK_flight_fares_flight_id" FOREIGN KEY ("flight_id")
          REFERENCES "flights" ("id"),
        CONSTRAINT "CHK_flight_fares_fare_class"
          CHECK ("fare_class" IN ('ECONOMY', 'BUSINESS')),
        CONSTRAINT "CHK_flight_fares_amount_positive" CHECK ("amount_vnd" > 0),
        CONSTRAINT "CHK_flight_fares_amount_safe"
          CHECK ("amount_vnd" <= 9007199254740991)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "flight_fares"`);
  }
}
