import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresFlightSearch } from "../../src/flights/postgres/postgres-flight-search.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { runFlightSearchContract } from "../contracts/flight-search.contract.js";
import { FIXTURE_DESTINATION, FIXTURE_ORIGIN, makeFlight } from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { occupySeats } from "./occupy-seats.js";

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

test("a search page is one SQL statement, whatever its size (no query per flight), and so are one flight's details", async () => {
  const flights = createPostgresFlightRepository(dataSource);
  const created = Array.from({ length: 12 }, () => makeFlight());
  for (const flight of created) {
    await flights.create(flight);
  }
  const dates = created.map((flight) => flight.departureAt.slice(0, 10)).sort();

  const queries: string[] = [];
  const counting = createBookingDataSource(parsePostgresConfig(process.env));
  counting.setOptions({
    logging: ["query"],
    logger: {
      logQuery: (query) => void queries.push(query),
      logQueryError: () => {},
      logQuerySlow: () => {},
      logSchemaBuild: () => {},
      logMigration: () => {},
      log: () => {},
    },
  });
  await counting.initialize();

  try {
    const search = createPostgresFlightSearch(counting);
    const countFor = async (limit: number) => {
      queries.length = 0;
      const page = await search.search(
        {
          origin: FIXTURE_ORIGIN.code,
          destination: FIXTURE_DESTINATION.code,
          // makeFlight spaces fixtures a day apart; 7 local dates hold 7 of them.
          departureDateFrom: dates[0]!,
          departureDateTo: dates[6]!,
          passengers: 1,
          sort: "price",
          limit,
        },
        new Date("2026-07-20T00:00:00.000Z"),
      );
      assert.equal(page.items.length, limit);
      return [...queries];
    };

    const one = await countFor(1);
    const six = await countFor(6);
    assert.equal(one.length, 1, one.join("\n---\n"));
    assert.equal(six.length, 1, six.join("\n---\n"));

    // US-FLT-05: one flight's details, every class counted, also one statement.
    queries.length = 0;
    const details = await search.findDetails(created[0]!.id);
    assert.equal(details?.availability.length, 1);
    assert.equal(queries.length, 1, queries.join("\n---\n"));
  } finally {
    await counting.destroy();
  }
});

runFlightSearchContract("postgres", async () => {
  const flights = createPostgresFlightRepository(dataSource);
  return {
    search: createPostgresFlightSearch(dataSource),
    async addFlight(flight) {
      const result = await flights.create(flight);
      assert.equal(result.outcome, "created", `fixture flight: ${JSON.stringify(result)}`);
    },
    occupy: (flightId, codes) => occupySeats(dataSource, flightId, codes),
  };
});
