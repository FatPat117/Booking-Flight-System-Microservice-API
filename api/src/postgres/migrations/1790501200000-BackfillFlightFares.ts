import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 49A — backfill (2 of 4). Copies only the fares that can be known:
 *
 * - A VND flight's `price_in_cents` becomes its ECONOMY fare, unchanged.
 *   Despite the column name it already held whole đồng (1500000 is
 *   1.5 million đồng), so nothing is divided or multiplied.
 * - Only when the flight has ECONOMY seats: a fare for a class with no
 *   seats would break BR-FLT-09.
 *
 * Not guessed: BUSINESS fares (there was one price per flight) and USD
 * flights (no exchange rate belongs in a migration — it would be wrong the
 * next day). Those flights are left without the fare; the contract step
 * lists them and refuses until someone sets the fare by hand.
 *
 * Idempotent: an existing fare is never overwritten.
 */
export class BackfillFlightFares1790501200000 implements MigrationInterface {
  name = "BackfillFlightFares1790501200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "flight_fares" ("flight_id", "fare_class", "amount_vnd")
      SELECT f."id", 'ECONOMY', f."price_in_cents"
      FROM "flights" f
      WHERE f."currency" = 'VND'
        AND EXISTS (
          SELECT 1 FROM "flight_seats" fs
          WHERE fs."flight_id" = f."id" AND fs."fare_class" = 'ECONOMY'
        )
      ON CONFLICT ("flight_id", "fare_class") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "flight_fares"`);
  }
}
