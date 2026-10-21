import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 49A — contract (3 of 4). Drops `flights.price_in_cents` and
 * `flights.currency`: prices live in `flight_fares` from here.
 *
 * Checks BR-FLT-09 on existing data first, the last moment the old price is
 * still there to show next to the problem. Refuses — never guesses a price —
 * listing each problem (the Day 44/46/47/48A convention):
 *
 * 1. A fare class with seats on the flight but no fare (every BUSINESS
 *    cabin, and every USD flight, after the backfill).
 * 2. A fare for a class the flight has no seats in.
 *
 * Migrations run one transaction each, so a refusal keeps `flight_fares` for
 * the manual fix; then run migrations again.
 */
export class ContractFlightFares1790504800000 implements MigrationInterface {
  name = "ContractFlightFares1790504800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        problems text;
      BEGIN
        SELECT string_agg(line, E'\\n' ORDER BY line)
        INTO problems
        FROM (
          SELECT format('  flight %s (%s, old price %s %s): %s seat(s) in %s, no fare',
                        f.flight_number, f.id, f.price_in_cents, f.currency,
                        count(*), fs.fare_class) AS line
          FROM flights f
          JOIN flight_seats fs ON fs.flight_id = f.id
          WHERE NOT EXISTS (
            SELECT 1 FROM flight_fares ff
            WHERE ff.flight_id = f.id AND ff.fare_class = fs.fare_class
          )
          GROUP BY f.id, f.flight_number, f.price_in_cents, f.currency, fs.fare_class
          UNION ALL
          SELECT format('  flight %s (%s): fare for %s, but no seat in that class',
                        f.flight_number, f.id, ff.fare_class)
          FROM flight_fares ff
          JOIN flights f ON f.id = ff.flight_id
          WHERE NOT EXISTS (
            SELECT 1 FROM flight_seats fs
            WHERE fs.flight_id = ff.flight_id AND fs.fare_class = ff.fare_class
          )
        ) AS mismatches;

        IF problems IS NOT NULL THEN
          RAISE EXCEPTION E'Flight fares do not match the seats (BR-FLT-09):\\n%', problems
            USING HINT = 'Set each missing fare in whole VND (đồng, never x100; a USD price must be '
              || 'converted by hand): INSERT INTO flight_fares (flight_id, fare_class, amount_vnd) '
              || 'VALUES (''<id>'', ''BUSINESS'', 4200000). Remove a fare with no seats: '
              || 'DELETE FROM flight_fares WHERE flight_id = ''<id>'' AND fare_class = ''<class>''. '
              || 'Then run migrations again.';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "flights"
        DROP CONSTRAINT "CHK_flights_price_positive",
        DROP CONSTRAINT "CHK_flights_currency",
        DROP COLUMN "price_in_cents",
        DROP COLUMN "currency"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "flights"
        ADD COLUMN "price_in_cents" integer,
        ADD COLUMN "currency" character varying
    `);

    // Lossy: one price per flight fits — the ECONOMY fare, or the lowest
    // one for a flight without ECONOMY. BUSINESS fares stay in flight_fares
    // until BackfillFlightFares is reverted too.
    await queryRunner.query(`
      UPDATE "flights" f
      SET "price_in_cents" = fare."amount_vnd", "currency" = 'VND'
      FROM (
        SELECT DISTINCT ON ("flight_id") "flight_id", "amount_vnd"
        FROM "flight_fares"
        ORDER BY "flight_id", ("fare_class" = 'ECONOMY') DESC, "amount_vnd"
      ) fare
      WHERE fare."flight_id" = f."id"
    `);

    await queryRunner.query(`
      ALTER TABLE "flights"
        ALTER COLUMN "price_in_cents" SET NOT NULL,
        ALTER COLUMN "currency" SET NOT NULL,
        ADD CONSTRAINT "CHK_flights_price_positive" CHECK ("price_in_cents" > 0),
        ADD CONSTRAINT "CHK_flights_currency" CHECK ("currency" IN ('VND', 'USD'))
    `);
  }
}
