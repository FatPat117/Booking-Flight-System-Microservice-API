import type { DataSource } from "typeorm";

import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
  TEST_AIRCRAFT,
} from "../fixtures/flights.js";

/**
 * Inserts the airports and aircraft that tests/fixtures/flights.ts refers
 * to, so flights satisfy their foreign keys (Day 46). Idempotent: call it in
 * beforeEach after any TRUNCATE. Since Day 47 the aircraft carry the same
 * layouts as TEST_AIRCRAFT (120 and 5 seats): creating a flight copies them
 * into its seat inventory, and makeFlight's `availableSeats` assumes them.
 */
export async function insertFlightReferences(
  dataSource: DataSource,
): Promise<void> {
  await dataSource.query(
    `INSERT INTO "airports" ("id", "code", "name", "city", "time_zone", "created_at")
     VALUES ($1, $2, 'Fixture Origin', 'Origin City', 'Asia/Ho_Chi_Minh', now()),
            ($3, $4, 'Fixture Destination', 'Destination City', 'Asia/Ho_Chi_Minh', now())
     ON CONFLICT DO NOTHING`,
    [
      FIXTURE_ORIGIN.id,
      FIXTURE_ORIGIN.code,
      FIXTURE_DESTINATION.id,
      FIXTURE_DESTINATION.code,
    ],
  );

  await dataSource.query(
    `INSERT INTO "aircraft" ("id", "registration", "model", "created_at")
     VALUES ($1, 'ZZ-FX1', 'Fixture A321', now()),
            ($2, 'ZZ-FX2', 'Fixture A321', now())
     ON CONFLICT DO NOTHING`,
    [FIXTURE_AIRCRAFT_ID, FIXTURE_OTHER_AIRCRAFT_ID],
  );

  await insertAircraftSeats(dataSource);
}

async function insertAircraftSeats(dataSource: DataSource): Promise<void> {
  for (const aircraft of TEST_AIRCRAFT) {
    await dataSource.query(
      `INSERT INTO "seats" ("aircraft_id", "row", "letter", "fare_class")
       SELECT $1, seat.row, seat.letter, seat.fare_class
       FROM unnest($2::smallint[], $3::text[], $4::text[]) AS seat(row, letter, fare_class)
       ON CONFLICT DO NOTHING`,
      [
        aircraft.id,
        aircraft.seats.map((seat) => seat.position.row),
        aircraft.seats.map((seat) => seat.position.letter),
        aircraft.seats.map((seat) => seat.fareClass),
      ],
    );
  }
}

/**
 * Leaves the flight only its first `count` seats in (row, letter) order —
 * how a test gets a 1- or 5-seat flight from the 120-seat fixture aircraft.
 * The kept seats are the codes the in-memory fake generates (1A, 1B, ...).
 */
export async function keepFirstSeats(
  dataSource: DataSource,
  flightId: string,
  count: number,
): Promise<void> {
  await dataSource.query(
    `DELETE FROM "flight_seats" WHERE "flight_id" = $1
       AND ("row", "letter") NOT IN (
         SELECT "row", "letter" FROM "flight_seats" WHERE "flight_id" = $1
         ORDER BY "row", "letter" LIMIT $2)`,
    [flightId, count],
  );
}
