import type { DataSource } from "typeorm";

import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
} from "../fixtures/flights.js";

/**
 * Inserts the airports and aircraft that tests/fixtures/flights.ts refers
 * to, so flights satisfy their foreign keys (Day 46). Idempotent: call it in
 * beforeEach after any TRUNCATE. Aircraft get no seats — no flight test
 * reads a layout.
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
}
