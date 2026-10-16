import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 48A (2 of 5). Every booking gets a 6-character reference from the
 * unambiguous alphabet (BR-BOOK-05, domain-model `BookingReference`).
 *
 * Backfill in SQL, row by row, retrying a taken code:
 * - Randomness: bytes 0–5 of gen_random_uuid() (core since PG13, from a
 *   cryptographically strong source; no pgcrypto needed). Bytes 6 and 8 carry
 *   the UUID version/variant bits, so they are not used.
 * - The alphabet has 32 characters and 256 is a multiple of 32, so
 *   `byte % 32` picks every character with the same probability.
 * - Collisions: 32^6 ≈ 1.07 billion codes, so one draw rarely hits a taken
 *   one, but across many bookings a duplicate somewhere becomes likely
 *   (birthday paradox). The loop draws again until the code is free;
 *   UQ_bookings_reference exists before the backfill, so a bug in the loop
 *   fails the migration instead of storing a duplicate.
 * - The format CHECK mirrors isBookingReference() in booking-reference.ts.
 */
export class AddBookingReference1790479600000 implements MigrationInterface {
  name = "AddBookingReference1790479600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
        ADD COLUMN "reference" text,
        ADD CONSTRAINT "UQ_bookings_reference" UNIQUE ("reference")
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        booking record;
        bytes bytea;
        candidate text;
      BEGIN
        FOR booking IN SELECT id FROM bookings WHERE reference IS NULL LOOP
          LOOP
            bytes := uuid_send(gen_random_uuid());
            candidate := '';
            FOR i IN 0..5 LOOP
              candidate := candidate || substr(alphabet, get_byte(bytes, i) % 32 + 1, 1);
            END LOOP;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM bookings WHERE reference = candidate);
          END LOOP;
          UPDATE bookings SET reference = candidate WHERE id = booking.id;
        END LOOP;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
        ALTER COLUMN "reference" SET NOT NULL,
        ADD CONSTRAINT "CHK_bookings_reference_format"
          CHECK ("reference" ~ '^[A-HJ-NP-Z2-9]{6}$')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN "reference"
    `);
  }
}
