import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { DataSource } from "typeorm";

import type { FlightSearchQuery, FlightSearchSort } from "../../src/flights/flight-search.js";
import { createPostgresFlightRepository } from "../../src/flights/postgres/postgres-flight-repository.js";
import { createPostgresFlightSearch } from "../../src/flights/postgres/postgres-flight-search.js";
import { parsePostgresConfig } from "../../src/postgres/config.js";
import { createBookingDataSource } from "../../src/postgres/data-source.js";
import type { Flight } from "../../src/types.js";
import {
  FIXTURE_AIRCRAFT_ID,
  FIXTURE_DESTINATION,
  FIXTURE_LONDON,
  FIXTURE_ORIGIN,
  FIXTURE_OTHER_AIRCRAFT_ID,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight,
  TEST_AIRCRAFT,
} from "../fixtures/flights.js";
import { insertFlightReferences } from "./flight-references.js";
import { occupySeats } from "./occupy-seats.js";

/**
 * Day 51 — differential test of the flight search (BR-FLT-10).
 *
 * Random worlds (seeded, so a failure can be replayed with
 * FLIGHT_SEARCH_SEED=<n>) are written to Postgres; every query is answered
 * by the adapter and by `naiveSearch` below, and the two lists must be
 * identical, order included.
 *
 * `naiveSearch` is written from the business definition and imports nothing
 * from src/: it looks at every flight, asks Intl for the departure's local
 * date in the origin's zone (a table of its own, not the database's), and
 * counts seats one by one. If the SQL and this ever agree on a wrong answer
 * it is because both misread the rule, not because they share a helper.
 */

const SEEDS = Number(process.env.FLIGHT_SEARCH_SEEDS ?? 50);
const ONLY_SEED = process.env.FLIGHT_SEARCH_SEED === undefined ? undefined : Number(process.env.FLIGHT_SEARCH_SEED);
const FLIGHTS_PER_WORLD = 24;
const QUERIES_PER_WORLD = 10;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The naive side's own idea of the airports' zones. */
const ZONES: Readonly<Record<string, string>> = {
  ZZA: "Asia/Ho_Chi_Minh",
  ZZB: "Asia/Ho_Chi_Minh",
  ZZL: "Europe/London",
};
const PLACES = { ZZA: FIXTURE_ORIGIN, ZZB: FIXTURE_DESTINATION, ZZL: FIXTURE_LONDON } as const;
type Code = keyof typeof PLACES;
const ROUTES: ReadonlyArray<readonly [Code, Code]> = [
  ["ZZA", "ZZB"],
  ["ZZB", "ZZA"],
  ["ZZL", "ZZA"],
  ["ZZA", "ZZL"],
];
const AIRCRAFT = [FIXTURE_AIRCRAFT_ID, FIXTURE_OTHER_AIRCRAFT_ID, FIXTURE_TWO_CLASS_AIRCRAFT_ID];
/** Five-day windows: London springs forward on 2027-03-28 and falls back on 2027-10-31. */
const EPOCHS = [Date.UTC(2027, 2, 26), Date.UTC(2027, 9, 29), Date.UTC(2027, 5, 10)];

/** mulberry32: a tiny seeded PRNG, so every world can be rebuilt from its seed. */
function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

type WorldFlight = {
  flight: Flight;
  seats: Array<{ code: string; fareClass: string; sold: boolean }>;
};

// ---- the naive side ----

function localDateOf(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

type Answer = { id: string; lowestFare: number; availability: Array<[string, number, number]> };

function naiveSearch(world: readonly WorldFlight[], query: FlightSearchQuery, now: Date): Answer[] {
  const answers: Array<Answer & { departure: number }> = [];

  for (const { flight, seats } of world) {
    if (flight.origin !== query.origin || flight.destination !== query.destination) continue;
    const zone = ZONES[flight.origin];
    if (zone === undefined) continue;
    const date = localDateOf(flight.departureAt, zone);
    if (date < query.departureDateFrom || date > query.departureDateTo) continue;
    // On sale: stored OPEN and more than one hour before departure.
    if (flight.status !== "OPEN") continue;
    if (!(Date.parse(flight.departureAt) - HOUR > now.getTime())) continue;

    const availability: Array<[string, number, number]> = [];
    for (const [fareClass, fare] of Object.entries(flight.fares)) {
      let free = 0;
      for (const seat of seats) {
        if (seat.fareClass === fareClass && !seat.sold) free += 1;
      }
      availability.push([fareClass, free, fare.amount]);
    }
    availability.sort((a, b) => a[2] - b[2] || (a[0] < b[0] ? -1 : 1));
    const roomy = availability.filter(([, free]) => free >= query.passengers);
    if (roomy.length === 0) continue;

    answers.push({
      id: flight.id,
      lowestFare: Math.min(...roomy.map(([, , amount]) => amount)),
      availability,
      departure: Date.parse(flight.departureAt),
    });
  }

  answers.sort((a, b) => {
    if (query.sort === "price" && a.lowestFare !== b.lowestFare) return a.lowestFare - b.lowestFare;
    if (a.departure !== b.departure) return a.departure - b.departure;
    return a.id < b.id ? -1 : 1;
  });
  return answers.map(({ id, lowestFare, availability }) => ({ id, lowestFare, availability }));
}

// ---- building a world ----

let dataSource: DataSource;

before(async () => {
  dataSource = createBookingDataSource(parsePostgresConfig(process.env));
  await dataSource.initialize();
  await dataSource.runMigrations();
});

after(async () => {
  await dataSource.destroy();
});

/** Local midnights in UTC around an epoch, ±1 minute: where day boundaries bite. */
function edgeInstants(epoch: number): number[] {
  const edges: number[] = [];
  for (let day = -1; day <= 6; day += 1) {
    for (const hour of [17, 23, 0]) {
      const base = epoch + day * DAY + hour * HOUR;
      edges.push(base - MINUTE, base, base + MINUTE);
    }
  }
  return edges;
}

async function buildWorld(seed: number) {
  const random = prng(seed);
  const epoch = random.pick(EPOCHS);
  const edges = edgeInstants(epoch);
  await dataSource.query('TRUNCATE TABLE "bookings", "flights", "audit_logs", "outbox" CASCADE');
  await insertFlightReferences(dataSource);
  const repository = createPostgresFlightRepository(dataSource);
  const world: WorldFlight[] = [];

  for (let index = 0; index < FLIGHTS_PER_WORLD; index += 1) {
    const [from, to] = random.pick(ROUTES);
    const aircraftId = random.pick(AIRCRAFT);
    const departure =
      random.next() < 0.4 ? random.pick(edges) : epoch + random.int(-1 * 24 * 60, 6 * 24 * 60) * MINUTE;
    const roll = random.next();
    const flight = makeFlight({
      aircraftId,
      originAirportId: PLACES[from].id,
      origin: from,
      destinationAirportId: PLACES[to].id,
      destination: to,
      departureAt: new Date(departure).toISOString(),
      arrivalAt: new Date(departure + random.int(60, 13 * 60) * MINUTE).toISOString(),
      status: roll < 0.7 ? "OPEN" : roll < 0.85 ? "SCHEDULED" : "CANCELLED",
    });
    const created = await repository.create(flight);
    if (created.outcome !== "created") continue; // the aircraft was busy: no flight

    const layout = TEST_AIRCRAFT.find((aircraft) => aircraft.id === aircraftId)!.seats;
    const seats = layout.map((seat) => ({
      code: `${seat.position.row}${seat.position.letter}`,
      fareClass: seat.fareClass,
      sold: false,
    }));
    const mode = random.int(0, 4);
    for (const seat of seats) {
      seat.sold =
        mode === 1 ? random.next() < 0.5
        : mode === 2 ? seat.fareClass === "ECONOMY" && random.next() < 0.97
        : mode === 3 ? seat.fareClass === "BUSINESS"
        : mode === 4 ? random.next() < 0.93
        : false;
    }
    await occupySeats(dataSource, flight.id, seats.filter((seat) => seat.sold).map((seat) => seat.code));
    world.push({ flight, seats });
  }

  return { random, epoch, world };
}

function randomQuery(random: ReturnType<typeof prng>, epoch: number): FlightSearchQuery {
  const [origin, destination] = random.next() < 0.05 ? (["ZZA", "QQQ"] as const) : random.pick(ROUTES);
  const from = epoch + random.int(-1, 5) * DAY;
  const to = from + random.int(0, 3) * DAY;
  return {
    origin,
    destination,
    departureDateFrom: new Date(from).toISOString().slice(0, 10),
    departureDateTo: new Date(to).toISOString().slice(0, 10),
    passengers: random.next() < 0.7 ? random.int(1, 3) : random.int(4, 9),
    sort: random.pick<FlightSearchSort>(["departure", "price"]),
    limit: 100,
  };
}

function randomNow(random: ReturnType<typeof prng>, epoch: number, world: readonly WorldFlight[]): Date {
  if (world.length > 0 && random.next() < 0.3) {
    // Exactly at, or 1 ms before, some flight's sales close.
    const flight = random.pick(world).flight;
    return new Date(Date.parse(flight.departureAt) - HOUR - random.int(0, 1));
  }
  return new Date(epoch - 2 * DAY + random.int(0, 6 * 24 * 60) * MINUTE);
}

test(`the SQL search answers exactly what a naive filter answers, over ${ONLY_SEED === undefined ? SEEDS : 1} random worlds`, async (t) => {
  const search = createPostgresFlightSearch(dataSource);
  const seeds = ONLY_SEED === undefined ? Array.from({ length: SEEDS }, (_, index) => 1_000 + index) : [ONLY_SEED];
  let compared = 0;
  let nonEmpty = 0;

  for (const seed of seeds) {
    const { random, epoch, world } = await buildWorld(seed);

    for (let index = 0; index < QUERIES_PER_WORLD; index += 1) {
      const query = randomQuery(random, epoch);
      const now = randomNow(random, epoch, world);
      const expected = naiveSearch(world, query, now);
      const replay = `seed ${seed} (replay: FLIGHT_SEARCH_SEED=${seed}), query ${index}: ${JSON.stringify(query)} at ${now.toISOString()}`;
      let actual: Answer[];
      try {
        actual = (await search.search(query, now)).items.map((item) => ({
          id: item.id,
          lowestFare: item.lowestFare.amount,
          availability: item.availability.map(
            (entry): [string, number, number] => [entry.fareClass, entry.availableSeats, entry.fare.amount],
          ),
        }));
      } catch (error) {
        // A throw is a failure too, and it must name its seed as well.
        throw new Error(`${replay}\n${String(error)}`, { cause: error });
      }

      assert.deepEqual(actual, expected, replay);
      compared += 1;
      if (expected.length > 0) nonEmpty += 1;
    }
  }

  t.diagnostic(`${seeds.length} worlds, ${compared} queries compared, ${nonEmpty} with results`);
  // A differential test that only ever compares empty lists proves nothing.
  assert.ok(nonEmpty >= compared / 4, `only ${nonEmpty} of ${compared} queries found anything`);
});
