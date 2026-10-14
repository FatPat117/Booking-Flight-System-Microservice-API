import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 47 — contract (3 of 3). Drops `flights.available_seats`: from here the
 * number of free seats is a count of AVAILABLE `flight_seats` rows, with no
 * second copy to drift (domain-model Decision 3).
 *
 * Refuses — never deletes, never "fixes" — in two cases, listing each one
 * (the Day 44 / Day 46 convention):
 *
 * 1. An active booking still has no seat (its flight had more active
 *    bookings than its aircraft has seats). Which booking loses is a human
 *    decision: cancel it, or move the flight to a bigger aircraft.
 * 2. Reconciliation: the old counter disagrees with the derived count. The
 *    counter is about to be deleted, so this is the last moment to prove the
 *    new value is the same answer. A mismatch means the counter was already
 *    wrong (e.g. `available_seats` chosen by the client before Day 46); the
 *    derived value is the truth, but a person has to look first.
 *
 * Migrations run one transaction each, so a refusal leaves expand + backfill
 * applied for a manual fix; then run migrations again.
 */
export class ContractFlightSeats1790472400000 implements MigrationInterface {
  name = "ContractFlightSeats1790472400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        problems text;
      BEGIN
        SELECT string_agg(line, E'\\n' ORDER BY line)
        INTO problems
        FROM (
          SELECT format('  booking %s on %s (%s): no seat left on aircraft %s',
                        b.id, f.flight_number, f.id, a.registration) AS line
          FROM bookings b
          JOIN flights f ON f.id = b.flight_id
          JOIN aircraft a ON a.id = f.aircraft_id
          WHERE b.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM flight_seats fs WHERE fs.booking_id = b.id)
          UNION ALL
          SELECT format('  flight %s (%s): available_seats = %s, AVAILABLE flight_seats = %s',
                        f.flight_number, f.id, f.available_seats, coalesce(free.count, 0))
          FROM flights f
          LEFT JOIN (
            SELECT flight_id, count(*) AS count
            FROM flight_seats
            WHERE status = 'AVAILABLE'
            GROUP BY flight_id
          ) free ON free.flight_id = f.id
          WHERE f.available_seats <> coalesce(free.count, 0)
        ) AS mismatches;

        IF problems IS NOT NULL THEN
          RAISE EXCEPTION E'Seat inventory does not match the bookings or the counter:\\n%', problems
            USING HINT = 'A booking without a seat: cancel it (UPDATE bookings SET status = ''cancelled'' '
              || 'WHERE id = ''<booking id>'') or give its flight a bigger aircraft. '
              || 'A counter mismatch: the counter was wrong before today; once checked, accept the '
              || 'derived value (UPDATE flights SET available_seats = <AVAILABLE count> WHERE id = ''<flight id>''). '
              || 'Then run migrations again.';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "flights" DROP COLUMN "available_seats"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "flights" ADD COLUMN "available_seats" integer
    `);

    await queryRunner.query(`
      UPDATE "flights" f
      SET "available_seats" = (
        SELECT count(*) FROM "flight_seats" fs
        WHERE fs."flight_id" = f."id" AND fs."status" = 'AVAILABLE'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "flights"
        ALTER COLUMN "available_seats" SET NOT NULL,
        ADD CONSTRAINT "CHK_flights_seats_nonnegative"
          CHECK ("available_seats" >= 0)
    `);
  }
}
