import assert from "node:assert/strict";
import { after, before, beforeEach } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresBookingRepository } from "../../src/bookings/postgres/postgres-booking-repository.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { runBookingRepositoryContract } from "../contracts/booking-repository.contract.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * The same contract the in-memory fake runs in the unit tier
 * (tests/booking-repository.contract.test.ts), here against real Postgres.
 */

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "bookings", "flights" CASCADE');
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.destroy();
});

runBookingRepositoryContract("postgres", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);

  return {
    repository: createPostgresBookingRepository(dataSource),
    async insertFlight(flight) {
      assert.deepEqual(await flightRepository.create(flight), { outcome: "created" });
    },
  };
});
