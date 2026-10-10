import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { DataSource } from "typeorm";

import { createPostgresAircraftRepository } from "../../src/aircraft/postgres/postgres-aircraft-repository.js";
import { createPostgresAirportRepository } from "../../src/airports/postgres/postgres-airport-repository.js";
import { createPostgresAuditRecorder } from "../../src/audit/postgres/postgres-audit-recorder.js";
import { createCreateFlight } from "../../src/flights/create-flight.js";
import type { FlightRepository } from "../../src/flights/flight-repository.js";
import { createOpenFlight } from "../../src/flights/open-flight.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresOutboxRepository } from "../../src/outbox/postgres/postgres-outbox-repository.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import { createPostgresTransactionRunner } from "../../src/transactions/postgres-transaction-runner.js";
import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_ORIGIN,
  makeFlight,
} from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";

/**
 * Day 46 races, on real Postgres (ADR-005: a fake cannot lose a race).
 *
 * BR-FLT-03 ("one aircraft, one flight at a time") is a rule about *other
 * rows*, so no conditional UPDATE on one row can enforce it — only the
 * EXCL_flights_aircraft_schedule exclusion constraint. Test B shows why by
 * running the obvious application-side check against a table that lacks it.
 */

const NOW = new Date("2026-07-20T00:00:00.000Z");
const ADMIN = { accountId: "aaaaaaaa-0000-4000-8000-000000000001" };
const PROBE_TABLE = "flights_schedule_probe";

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
  // A copy of the columns the rule needs, deliberately without the
  // exclusion constraint — the real schema is never weakened.
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "${PROBE_TABLE}" (
      "aircraft_id" uuid NOT NULL,
      "departure_at" timestamptz NOT NULL,
      "arrival_at" timestamptz NOT NULL
    )
  `);
});

beforeEach(async () => {
  await dataSource.query(
    `TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox", "${PROBE_TABLE}" CASCADE`,
  );
  await insertFlightReferences(dataSource);
});

after(async () => {
  await dataSource.query(`DROP TABLE IF EXISTS "${PROBE_TABLE}"`);
  await dataSource.destroy();
});

function createCreateFlightUseCase() {
  return createCreateFlight({
    flightRepository: createPostgresFlightRepository(dataSource),
    airportRepository: createPostgresAirportRepository(dataSource),
    aircraftRepository: createPostgresAircraftRepository(dataSource),
    auditRecorder: createPostgresAuditRecorder(dataSource),
    outboxRepository: createPostgresOutboxRepository(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => NOW,
  });
}

/** Departures 10 min apart, 2 h long: every pair overlaps. */
function overlappingWindow(index: number) {
  const departure = new Date(Date.UTC(2027, 5, 1, 8, index * 10));
  const arrival = new Date(departure.getTime() + 2 * 60 * 60 * 1000);
  return { departureAt: departure.toISOString(), arrivalAt: arrival.toISOString() };
}

/**
 * Resolves once `parties` callers have arrived: forces the worst
 * interleaving (everyone read before anyone wrote) instead of hoping a sleep
 * produces it — a 50 ms pause let a slow caller read after a fast one wrote.
 */
function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const everyone = new Promise<void>((resolve) => {
    release = resolve;
  });

  return () => {
    arrived += 1;
    if (arrived === parties) {
      release();
    }
    return everyone;
  };
}

async function countRows(table: string): Promise<number> {
  const [row] = (await dataSource.query(
    `SELECT count(*)::int AS count FROM "${table}"`,
  )) as { count: number }[];
  return row?.count ?? 0;
}

test("Test A — 10 concurrent createFlight calls for one aircraft in overlapping windows: exactly 1 created, 9 aircraft-unavailable", async () => {
  const createFlight = createCreateFlightUseCase();

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      createFlight(
        {
          flightNumber: `RC${100 + index}`,
          origin: FIXTURE_ORIGIN.code,
          destination: FIXTURE_DESTINATION.code,
          aircraftRegistration: "ZZ-FX1",
          ...overlappingWindow(index),
          priceInCents: 1_500_000,
          currency: "VND",
        },
        ADMIN,
      ),
    ),
  );

  const outcomes = results.map((result) => result.outcome);
  assert.equal(outcomes.filter((outcome) => outcome === "created").length, 1);
  assert.equal(
    outcomes.filter((outcome) => outcome === "aircraft-unavailable").length,
    9,
  );
  assert.equal(await countRows("flights"), 1);
  // The losers rolled back whole: no audit or outbox row without a flight.
  assert.equal(await countRows("audit_logs"), 1);
  assert.equal(await countRows("outbox"), 1);
});

test("Test B — check-then-insert in the application lets overlapping flights through; the exclusion constraint does not", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);

  /**
   * The rule written as application code: look for an overlapping flight,
   * then insert. The barrier stands in for any work between the two
   * statements; every caller passes the check before any of them inserts.
   */
  async function checkThenInsert(
    table: string,
    index: number,
    allChecked: () => Promise<void>,
    insert: () => Promise<unknown>,
  ): Promise<void> {
    const window = overlappingWindow(index);
    const [row] = (await dataSource.query(
      `SELECT count(*)::int AS count FROM "${table}"
        WHERE aircraft_id = $1
          AND flight_aircraft_occupancy(departure_at, arrival_at)
              && flight_aircraft_occupancy($2::timestamptz, $3::timestamptz)
          ${table === "flights" ? "AND status <> 'CANCELLED'" : ""}`,
      [FIXTURE_AIRCRAFT_ID, window.departureAt, window.arrivalAt],
    )) as { count: number }[];

    const free = (row?.count ?? 0) === 0;
    await allChecked();

    if (free) {
      await insert();
    }
  }

  const probeChecked = createBarrier(10);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      checkThenInsert(PROBE_TABLE, index, probeChecked, () => {
        const window = overlappingWindow(index);
        return dataSource.query(
          `INSERT INTO "${PROBE_TABLE}" VALUES ($1, $2, $3)`,
          [FIXTURE_AIRCRAFT_ID, window.departureAt, window.arrivalAt],
        );
      }),
    ),
  );

  // Every caller saw an empty schedule, so every one inserted.
  assert.equal(await countRows(PROBE_TABLE), 10);

  const outcomes: string[] = [];
  const flightsChecked = createBarrier(10);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      checkThenInsert("flights", index, flightsChecked, async () => {
        const result = await flightRepository.create(
          makeFlight({ aircraftId: FIXTURE_AIRCRAFT_ID, ...overlappingWindow(index) }),
        );
        outcomes.push(result.outcome);
      }),
    ),
  );

  // Same code, same interleaving: every insert was attempted, one survived.
  assert.equal(outcomes.length, 10);
  assert.equal(outcomes.filter((outcome) => outcome === "created").length, 1);
  assert.equal(
    outcomes.filter((outcome) => outcome === "aircraft-unavailable").length,
    9,
  );
  assert.equal(await countRows("flights"), 1);
});

test("Test C — 10 admins open the same SCHEDULED flight after all reading it: exactly 1 opened, 9 status-changed, one audit row", async () => {
  const inner = createPostgresFlightRepository(dataSource);
  const flight = makeFlight({ status: "SCHEDULED" });
  assert.deepEqual(await inner.create(flight), { outcome: "created" });

  // Every caller reads SCHEDULED before any writes, so all 10 reach the
  // compare-and-set with the same expected status.
  const CALLERS = 10;
  const allRead = createBarrier(CALLERS);
  const barrierRepository: FlightRepository = {
    ...inner,
    async findById(id) {
      const found = await inner.findById(id);
      await allRead();
      return found;
    },
  };

  const openFlight = createOpenFlight({
    flightRepository: barrierRepository,
    auditRecorder: createPostgresAuditRecorder(dataSource),
    transactionRunner: createPostgresTransactionRunner(dataSource),
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => NOW,
  });

  const results = await Promise.all(
    Array.from({ length: CALLERS }, () => openFlight(flight.id, ADMIN)),
  );

  const opened = results.filter((result) => result.outcome === "opened");
  const changed = results.filter((result) => result.outcome === "status-changed");
  assert.equal(opened.length, 1);
  assert.equal(changed.length, 9);
  for (const result of changed) {
    assert.deepEqual(result, { outcome: "status-changed", currentStatus: "OPEN" });
  }

  assert.equal((await inner.findById(flight.id))?.status, "OPEN");
  const [audit] = (await dataSource.query(
    `SELECT count(*)::int AS count FROM "audit_logs" WHERE action = 'FLIGHT_OPENED'`,
  )) as { count: number }[];
  assert.equal(audit?.count, 1);
});

test("a CANCELLED flight does not hold its aircraft: a new flight in the same window is created", async () => {
  const flightRepository = createPostgresFlightRepository(dataSource);
  const cancelled = makeFlight({ aircraftId: FIXTURE_AIRCRAFT_ID, ...overlappingWindow(0) });
  assert.deepEqual(await flightRepository.create(cancelled), { outcome: "created" });
  // No route cancels a flight before phase D step 9; set it directly.
  await dataSource.query(`UPDATE "flights" SET status = 'CANCELLED' WHERE id = $1`, [
    cancelled.id,
  ]);

  const result = await flightRepository.create(
    makeFlight({ aircraftId: FIXTURE_AIRCRAFT_ID, ...overlappingWindow(1) }),
  );

  assert.deepEqual(result, { outcome: "created" });
});
