import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { FlightEntity } from "../../src/flights/postgres/flight.entity.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import {
  createPostgresTransactionRunner,
  NestedTransactionError,
} from "../../src/transactions/postgres-transaction-runner.js";
import type { Flight } from "../../src/types.js";

/**
 * Tests the runner across repositories (Flight + Outbox together), not any
 * one repository's own behavior — kept in its own file so it isn't mistaken
 * for either repository's test suite.
 */

let dataSource: DataSource;

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: crypto.randomUUID(),
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T01:00:00.000Z",
    arrivalAt: "2026-08-10T03:00:00.000Z",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 120,
    ...overrides,
  };
}

function makeEntry(id: string) {
  return {
    id,
    eventType: "flight-created",
    payload: { type: "flight.created" },
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE "flights", "outbox"');
});

after(async () => {
  await dataSource.destroy();
});

test("commits Flight + Outbox writes together when operation resolves", async () => {
  const runner = createPostgresTransactionRunner(dataSource);
  const flightRepository = createPostgresFlightRepository(dataSource);
  const outboxRepository = createPostgresOutboxRepository(dataSource);
  const flight = makeFlight();

  await runner.run(async () => {
    await flightRepository.create(flight);
    await outboxRepository.enqueue(makeEntry(crypto.randomUUID()));
  });

  assert.notEqual(await flightRepository.findById(flight.id), undefined);
  assert.equal((await outboxRepository.findUnpublished(10)).length, 1);
});

test("rolls back Flight + Outbox writes together when operation rejects", async () => {
  const runner = createPostgresTransactionRunner(dataSource);
  const flightRepository = createPostgresFlightRepository(dataSource);
  const outboxRepository = createPostgresOutboxRepository(dataSource);
  const flight = makeFlight();

  await assert.rejects(
    () =>
      runner.run(async () => {
        await flightRepository.create(flight);
        await outboxRepository.enqueue(makeEntry(crypto.randomUUID()));
        throw new Error("boom");
      }),
    /boom/,
  );

  assert.equal(await flightRepository.findById(flight.id), undefined);
  assert.equal((await outboxRepository.findUnpublished(10)).length, 0);
});

test("nested run() throws NestedTransactionError and the outer transaction rolls back", async () => {
  const runner = createPostgresTransactionRunner(dataSource);
  const flightRepository = createPostgresFlightRepository(dataSource);
  const flight = makeFlight();

  await assert.rejects(
    () =>
      runner.run(async () => {
        await flightRepository.create(flight);
        await runner.run(async () => undefined);
      }),
    NestedTransactionError,
  );

  assert.equal(await flightRepository.findById(flight.id), undefined);
});

/**
 * Counter-proof (Day 37): reproduces the exact bug Step 3 fixed. A
 * repository built the pre-fix way — dataSource.getRepository(...) resolved
 * once, bypassing transaction-context entirely — never sees the
 * transactional EntityManager. Its write commits on the pool immediately
 * and survives even though the surrounding "transaction" rolls back.
 *
 * Kept permanently, not a one-off observation: if this test ever stops
 * reproducing the bug (the row stops surviving), that means an assumption
 * about connection isolation changed and is worth investigating — not that
 * the test should just be deleted.
 */
test("counter-proof: a repository that bypasses transaction-context is not part of the transaction", async () => {
  const runner = createPostgresTransactionRunner(dataSource);
  const legacyStyleRepository = dataSource.getRepository(FlightEntity);
  const flight = makeFlight();

  await assert.rejects(
    () =>
      runner.run(async () => {
        await legacyStyleRepository.insert({
          id: flight.id,
          flightNumber: flight.flightNumber,
          origin: flight.origin,
          destination: flight.destination,
          departureAt: new Date(flight.departureAt),
          arrivalAt: new Date(flight.arrivalAt),
          priceInCents: flight.priceInCents,
          currency: flight.currency,
          availableSeats: flight.availableSeats,
        });
        throw new Error("boom");
      }),
    /boom/,
  );

  const survived = await dataSource.manager.findOneBy(FlightEntity, {
    id: flight.id,
  });
  assert.notEqual(survived, null);
});
