import { after, before, beforeEach } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresAircraftRepository } from "../../src/aircraft/postgres/postgres-aircraft-repository.js";
import { createPostgresAirportRepository } from "../../src/airports/postgres/postgres-airport-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { runAircraftRepositoryContract } from "../contracts/aircraft-repository.contract.js";
import { runAirportRepositoryContract } from "../contracts/airport-repository.contract.js";

/**
 * The same contracts the in-memory fakes run in the unit tier
 * (tests/airport-repository.contract.test.ts,
 * tests/aircraft-repository.contract.test.ts), here against real Postgres.
 */

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "airports", "seats", "aircraft"');
});

after(async () => {
  await dataSource.destroy();
});

runAirportRepositoryContract("postgres", async () =>
  createPostgresAirportRepository(dataSource),
);

runAircraftRepositoryContract("postgres", async () =>
  createPostgresAircraftRepository(dataSource),
);
