import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 51. The flight search (Decision 17) asks for one route in one UTC
 * interval:
 *
 *   WHERE origin_airport_id = $o AND destination_airport_id = $d
 *     AND departure_at >= $start AND departure_at < $end
 *
 * Two equalities and a range: the equality columns lead and the range
 * column comes last, so the index reads exactly the route's flights in the
 * interval. Measured on 20 400 flights / 3.9 M seats (DAY-51 "Evidence for
 * phase E"): SGN→HAN over 3 days 10.4 ms with a sequential scan of flights,
 * 4.7 ms with this index; `(departure_at)` alone was as fast on that data
 * but read every route's flights in the interval and threw most away (211
 * rows for 3 days, 561 for a thin route over 7), which grows with routes.
 *
 * It also serves the origin foreign key (leading column), which had no index.
 * Plain CREATE INDEX: fine on dev data; CONCURRENTLY on a large live table.
 */
export class AddFlightSearchIndex1790522800000 implements MigrationInterface {
  name = "AddFlightSearchIndex1790522800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "idx_flights_route_departure"
      ON "flights" ("origin_airport_id", "destination_airport_id", "departure_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_flights_route_departure"`);
  }
}
