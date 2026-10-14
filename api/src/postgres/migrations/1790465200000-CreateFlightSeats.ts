import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 47 — expand (1 of 3). A flight's seat inventory (domain-model
 * Decision 10). Pure addition: nothing reads it yet, `available_seats` still
 * answers "how many seats are left" until the contract step.
 *
 * - A copy, not a reference: row / letter / fare_class are stored here, with
 *   no FK to `seats`. The template is read once, when the flight is created.
 * - PRIMARY KEY (flight_id, row, letter): one inventory row per position.
 *   Its leading column also serves FK_flight_seats_flight_id.
 * - Statuses AVAILABLE / BOOKED only; HELD arrives with timed holds (step 5).
 *   CHK_flight_seats_booking ties the columns together: a seat has a
 *   booking exactly when it is not AVAILABLE.
 * - UQ_flight_seats_booking_id: one booking occupies at most one seat. True
 *   while a booking has one passenger; step 5 drops it on purpose. It is also
 *   the index cancel uses to find a booking's seat. NULLs are distinct in a
 *   unique constraint, so every AVAILABLE seat may have a NULL booking_id.
 * - FK_flight_seats_booking_id is DEFERRABLE INITIALLY DEFERRED: CreateBooking
 *   claims the seat first and inserts the booking after it, in the same
 *   transaction; the FK is checked at COMMIT. No ON DELETE (NO ACTION), as
 *   for every FK here.
 * - idx_flight_seats_available is partial (WHERE status = 'AVAILABLE') and
 *   serves both queries that exist: "the first free seat of a flight in
 *   (row, letter) order" and "count free seats per flight". It shrinks as a
 *   flight sells, and a sold-out flight has no entries at all.
 */
export class CreateFlightSeats1790465200000 implements MigrationInterface {
  name = "CreateFlightSeats1790465200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "flight_seats" (
        "flight_id" uuid NOT NULL,
        "row" smallint NOT NULL,
        "letter" character(1) NOT NULL,
        "fare_class" text NOT NULL,
        "status" text NOT NULL,
        "booking_id" uuid,
        CONSTRAINT "PK_flight_seats" PRIMARY KEY ("flight_id", "row", "letter"),
        CONSTRAINT "FK_flight_seats_flight_id" FOREIGN KEY ("flight_id")
          REFERENCES "flights" ("id"),
        CONSTRAINT "FK_flight_seats_booking_id" FOREIGN KEY ("booking_id")
          REFERENCES "bookings" ("id") DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT "UQ_flight_seats_booking_id" UNIQUE ("booking_id"),
        CONSTRAINT "CHK_flight_seats_row" CHECK ("row" BETWEEN 1 AND 99),
        CONSTRAINT "CHK_flight_seats_letter" CHECK ("letter" ~ '^[A-K]$'),
        CONSTRAINT "CHK_flight_seats_fare_class"
          CHECK ("fare_class" IN ('ECONOMY', 'BUSINESS')),
        CONSTRAINT "CHK_flight_seats_status"
          CHECK ("status" IN ('AVAILABLE', 'BOOKED')),
        CONSTRAINT "CHK_flight_seats_booking"
          CHECK (("status" = 'AVAILABLE') = ("booking_id" IS NULL))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_flight_seats_available"
      ON "flight_seats" ("flight_id", "row", "letter")
      WHERE "status" = 'AVAILABLE'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "flight_seats"`);
  }
}
