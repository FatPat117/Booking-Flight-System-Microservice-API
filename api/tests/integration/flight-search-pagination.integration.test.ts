import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresFlightSearch } from "../../src/flights/postgres/postgres-flight-search.js";
import { createSearchFlights } from "../../src/flights/search-flights.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight,
  TEST_AIRCRAFT,
} from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { occupySeats } from "./occupy-seats.js";

/**
 * Day 51 Step 4 — keyset pages on Postgres (Decision 17, BR-FLT-11).
 *
 * 15 flights: three aircraft at the same minute on each of 5 days (ties on
 * departure_at, broken by id), and on even days the two-class flight's
 * economy sold out (so `sort = price` has ties and differences).
 */

let dataSource: DataSource;
const NOW = new Date("2027-01-01T00:00:00.000Z");
const RANGE = {
  origin: FIXTURE_ORIGIN.code,
  destination: FIXTURE_DESTINATION.code,
  departureDateFrom: "2027-03-10",
  departureDateTo: "2027-03-16",
};

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE');
  await insertFlightReferences(dataSource);
  const repository = createPostgresFlightRepository(dataSource);
  const economyOf = (aircraftId: string) =>
    TEST_AIRCRAFT.find((aircraft) => aircraft.id === aircraftId)!.seats
      .filter((seat) => seat.fareClass === "ECONOMY")
      .map((seat) => `${seat.position.row}${seat.position.letter}`);

  for (let day = 10; day <= 14; day += 1) {
    for (const aircraftId of [FIXTURE_AIRCRAFT_ID, FIXTURE_OTHER_AIRCRAFT_ID, FIXTURE_TWO_CLASS_AIRCRAFT_ID]) {
      const departure = Date.UTC(2027, 2, day, 1, 0, 0);
      const flight = makeFlight({
        aircraftId,
        departureAt: new Date(departure).toISOString(),
        arrivalAt: new Date(departure + 2 * 3600_000).toISOString(),
      });
      assert.equal((await repository.create(flight)).outcome, "created");
      if (aircraftId === FIXTURE_TWO_CLASS_AIRCRAFT_ID && day % 2 === 0) {
        await occupySeats(dataSource, flight.id, economyOf(aircraftId));
      }
    }
  }
});

after(async () => {
  await dataSource.destroy();
});

function searchFlights() {
  return createSearchFlights({ flightSearch: createPostgresFlightSearch(dataSource), getCurrentTime: () => NOW });
}

async function everything(sort: string): Promise<string[]> {
  const all = await searchFlights()({ ...RANGE, sort, limit: "50" });
  assert.equal(all.outcome, "success");
  return all.outcome === "success" ? all.items.map((item) => item.id) : [];
}

async function walk(query: Record<string, string>): Promise<string[]> {
  const search = searchFlights();
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    const result = await search({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(result.outcome, "success", JSON.stringify(result));
    if (result.outcome !== "success") break;
    ids.push(...result.items.map((item) => item.id));
    if (result.page.nextCursor === null) return ids;
    cursor = result.page.nextCursor;
  }
  throw new Error("walk did not end");
}

test("walking every page gives exactly the unpaginated result for page sizes 1, 2, 7 and more than the total, by departure and by price", async () => {
  for (const sort of ["departure", "price"]) {
    const expected = await everything(sort);
    assert.equal(expected.length, 15);
    assert.equal(new Set(expected).size, 15);
    for (const limit of ["1", "2", "7", "40"]) {
      assert.deepEqual(await walk({ ...RANGE, sort, limit }), expected, `${sort}, limit ${limit}`);
    }
  }
});

test("a flight on page 1 sells out before page 2 is read: keyset skips nobody; the OFFSET control skips one flight the customer never saw", async (t) => {
  const before = await everything("departure");
  const search = searchFlights();

  const page1 = await search({ ...RANGE, limit: "3" });
  assert.equal(page1.outcome, "success");
  if (page1.outcome !== "success") return;
  assert.deepEqual(page1.items.map((item) => item.id), before.slice(0, 3));

  // The second flight on page 1 sells out completely.
  const soldOut = page1.items[1]!;
  const seats = (await dataSource.query(
    `SELECT "row" || "letter" AS "code" FROM "flight_seats" WHERE "flight_id" = $1 AND "status" = 'AVAILABLE'`,
    [soldOut.id],
  )) as Array<{ code: string }>;
  await occupySeats(dataSource, soldOut.id, seats.map((seat) => seat.code));

  const page2 = await search({ ...RANGE, limit: "3", cursor: page1.page.nextCursor! });
  assert.equal(page2.outcome, "success");
  const keysetPage2 = page2.outcome === "success" ? page2.items.map((item) => item.id) : [];
  assert.deepEqual(keysetPage2, before.slice(3, 6), "keyset: page 2 starts right after the last flight shown");

  // Control, only here: what `OFFSET 3 LIMIT 3` over the same order returns now.
  const after = await everything("departure");
  const offsetPage2 = after.slice(3, 6);
  assert.deepEqual(offsetPage2, before.slice(4, 7));
  assert.ok(!offsetPage2.includes(before[3]!) && !page1.items.some((item) => item.id === before[3]));
  t.diagnostic(`OFFSET would skip ${before[3]}: on neither page 1 nor page 2`);
});
