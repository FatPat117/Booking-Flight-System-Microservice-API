import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 48A (3 of 5) — expand + backfill. A booking has 1–9 passengers
 * (BR-BOOK-01), one row each (domain-model Decision 11).
 *
 * - seat_row / seat_letter are a display COPY of the passenger's seat. The
 *   truth stays on flight_seats.booking_id (Decision 10): which seats a
 *   booking holds is guarded there; which passenger sits where is Booking's.
 * - UQ_booking_passengers_seat: a seat appears at most once in a booking
 *   (BR-BOOK-02). UQ_booking_passengers_position orders passengers and also
 *   serves FK_booking_passengers_booking_id lookups (leading column).
 * - The seat may be NULL only for a legacy booking cancelled before Day 48A:
 *   its seat was released then and is not known any more. A CHECK cannot see
 *   the booking's status, so "new passengers always have a seat" is the
 *   repository's job; CHK_booking_passengers_seat only keeps the two columns
 *   together.
 *
 * Backfill: each legacy booking becomes passenger 1 with its passenger_name
 * and the seat it holds now. The LEFT JOIN relies on UQ_flight_seats_booking_id
 * (at most one seat per booking) — which is why this runs before
 * AllowHeldSeats drops it: with several seats per booking the join would
 * create one passenger per seat.
 */
export class CreateBookingPassengers1790483200000 implements MigrationInterface {
  name = "CreateBookingPassengers1790483200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "booking_passengers" (
        "id" uuid NOT NULL,
        "booking_id" uuid NOT NULL,
        "position" smallint NOT NULL,
        "name" text NOT NULL,
        "seat_row" smallint,
        "seat_letter" character(1),
        CONSTRAINT "PK_booking_passengers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_booking_passengers_booking_id" FOREIGN KEY ("booking_id")
          REFERENCES "bookings" ("id"),
        CONSTRAINT "UQ_booking_passengers_position" UNIQUE ("booking_id", "position"),
        CONSTRAINT "UQ_booking_passengers_seat"
          UNIQUE ("booking_id", "seat_row", "seat_letter"),
        CONSTRAINT "CHK_booking_passengers_position" CHECK ("position" BETWEEN 1 AND 9),
        CONSTRAINT "CHK_booking_passengers_name" CHECK (length(btrim("name")) > 0),
        CONSTRAINT "CHK_booking_passengers_seat"
          CHECK (("seat_row" IS NULL) = ("seat_letter" IS NULL))
      )
    `);

    await queryRunner.query(`
      INSERT INTO "booking_passengers"
        ("id", "booking_id", "position", "name", "seat_row", "seat_letter")
      SELECT gen_random_uuid(), b."id", 1, b."passenger_name", fs."row", fs."letter"
      FROM "bookings" b
      LEFT JOIN "flight_seats" fs ON fs."booking_id" = b."id"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "booking_passengers"`);
  }
}
