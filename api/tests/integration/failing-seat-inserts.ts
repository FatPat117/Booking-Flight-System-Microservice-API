import type { DataSource } from "typeorm";

/**
 * Makes every INSERT into flight_seats fail, so a test can prove the flight
 * row written just before it does not survive. A trigger rather than bad
 * data: every seat a flight copies already passed the same CHECKs on
 * `seats`, so no layout can make the copy fail on its own.
 *
 * Returns the cleanup; call it in `finally`.
 */
export async function failSeatInserts(
  dataSource: DataSource,
): Promise<() => Promise<void>> {
  await dataSource.query(`
    CREATE OR REPLACE FUNCTION test_fail_seat_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'seat insert failed (test trigger)';
    END $$
  `);
  await dataSource.query(`
    CREATE TRIGGER test_fail_seat_insert BEFORE INSERT ON "flight_seats"
    FOR EACH STATEMENT EXECUTE FUNCTION test_fail_seat_insert()
  `);

  return async () => {
    await dataSource.query(
      `DROP TRIGGER IF EXISTS test_fail_seat_insert ON "flight_seats"`,
    );
    await dataSource.query(`DROP FUNCTION IF EXISTS test_fail_seat_insert()`);
  };
}
