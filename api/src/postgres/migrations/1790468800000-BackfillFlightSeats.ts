import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 47 — backfill (2 of 3).
 *
 * 1. Every existing flight gets one AVAILABLE seat per seat of its aircraft
 *    (the same INSERT … SELECT CreateFlight runs from now on).
 * 2. Every active booking gets a seat. Old bookings never had one, so this
 *    is a pairing of two lists per flight: number the active bookings by
 *    creation time, number the free seats by (row, letter), and give booking
 *    n seat n. Earliest booking, front-most seat — a deterministic rule, so
 *    a re-run on the same data gives the same answer.
 *
 * A flight with more active bookings than seats (possible before Day 46,
 * when the client chose `available_seats`) leaves the extra bookings without
 * a seat. This step does not hide that: the contract step lists them and
 * refuses.
 *
 * Idempotent: seats already present are skipped, and only bookings that hold
 * no seat yet are paired, with seats still AVAILABLE.
 */
export class BackfillFlightSeats1790468800000 implements MigrationInterface {
  name = "BackfillFlightSeats1790468800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "flight_seats" ("flight_id", "row", "letter", "fare_class", "status")
      SELECT f."id", s."row", s."letter", s."fare_class", 'AVAILABLE'
      FROM "flights" f
      JOIN "seats" s ON s."aircraft_id" = f."aircraft_id"
      ON CONFLICT ("flight_id", "row", "letter") DO NOTHING
    `);

    await queryRunner.query(`
      WITH unseated AS (
        SELECT b."id" AS booking_id, b."flight_id",
               row_number() OVER (
                 PARTITION BY b."flight_id" ORDER BY b."created_at", b."id"
               ) AS n
        FROM "bookings" b
        WHERE b."status" = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM "flight_seats" fs WHERE fs."booking_id" = b."id"
          )
      ),
      free AS (
        SELECT fs."flight_id", fs."row", fs."letter",
               row_number() OVER (
                 PARTITION BY fs."flight_id" ORDER BY fs."row", fs."letter"
               ) AS n
        FROM "flight_seats" fs
        WHERE fs."status" = 'AVAILABLE'
      )
      UPDATE "flight_seats" target
      SET "status" = 'BOOKED', "booking_id" = unseated.booking_id
      FROM unseated
      JOIN free ON free."flight_id" = unseated."flight_id" AND free.n = unseated.n
      WHERE target."flight_id" = free."flight_id"
        AND target."row" = free."row"
        AND target."letter" = free."letter"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "flight_seats"`);
  }
}
