import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 49A (4 of 4) — expand + backfill + constrain. Each passenger stores
 * the fare class and price of their seat as it was when the seats were held
 * (BR-BOOK-03, Decision 13). The booking total is derived from these, so it
 * has no column.
 *
 * Backfill — priced at MIGRATION time, not at hold time: bookings made
 * before Day 49A never recorded a price, so each passenger gets the current
 * fare of their seat's class. The seat is found by position on the flight
 * (not by flight_seats.booking_id), so a cancelled or expired booking's
 * passengers are priced too, although their seats were released.
 *
 * A passenger without a seat (cancelled before Day 48A, seat unknown) has
 * no class and no price; CHK_booking_passengers_fare keeps the three columns
 * NULL together. A passenger with a seat but no price is refused, with a
 * list: after ContractFlightFares it can only mean a seat position that is
 * not on the flight.
 */
export class AddPassengerFareSnapshot1790508400000 implements MigrationInterface {
  name = "AddPassengerFareSnapshot1790508400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "booking_passengers"
        ADD COLUMN "fare_class" text,
        ADD COLUMN "price_vnd" bigint
    `);

    await queryRunner.query(`
      UPDATE "booking_passengers" p
      SET "fare_class" = fs."fare_class", "price_vnd" = ff."amount_vnd"
      FROM "bookings" b
      JOIN "flight_seats" fs ON fs."flight_id" = b."flight_id"
      JOIN "flight_fares" ff
        ON ff."flight_id" = fs."flight_id" AND ff."fare_class" = fs."fare_class"
      WHERE b."id" = p."booking_id"
        AND fs."row" = p."seat_row"
        AND fs."letter" = p."seat_letter"
        AND p."price_vnd" IS NULL
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        problems text;
      BEGIN
        SELECT string_agg(
                 format('  booking %s (%s) passenger %s: seat %s%s has no fare',
                        b.reference, b.id, p.position, p.seat_row, p.seat_letter),
                 E'\\n' ORDER BY b.reference, p.position)
        INTO problems
        FROM booking_passengers p
        JOIN bookings b ON b.id = p.booking_id
        WHERE p.seat_row IS NOT NULL AND p.price_vnd IS NULL;

        IF problems IS NOT NULL THEN
          RAISE EXCEPTION E'Passengers whose seat cannot be priced:\\n%', problems
            USING HINT = 'The seat is not on the booking''s flight. Correct the passenger''s '
              || 'seat_row/seat_letter, or set fare_class and price_vnd by hand. '
              || 'Then run migrations again.';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "booking_passengers"
        ADD CONSTRAINT "CHK_booking_passengers_fare"
          CHECK (("seat_row" IS NULL) = ("fare_class" IS NULL)
             AND ("fare_class" IS NULL) = ("price_vnd" IS NULL)),
        ADD CONSTRAINT "CHK_booking_passengers_fare_class"
          CHECK ("fare_class" IN ('ECONOMY', 'BUSINESS')),
        ADD CONSTRAINT "CHK_booking_passengers_price_positive"
          CHECK ("price_vnd" > 0),
        ADD CONSTRAINT "CHK_booking_passengers_price_safe"
          CHECK ("price_vnd" <= 9007199254740991)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "booking_passengers"
        DROP CONSTRAINT IF EXISTS "CHK_booking_passengers_price_safe",
        DROP CONSTRAINT IF EXISTS "CHK_booking_passengers_price_positive",
        DROP CONSTRAINT IF EXISTS "CHK_booking_passengers_fare_class",
        DROP CONSTRAINT IF EXISTS "CHK_booking_passengers_fare",
        DROP COLUMN IF EXISTS "price_vnd",
        DROP COLUMN IF EXISTS "fare_class"
    `);
  }
}
