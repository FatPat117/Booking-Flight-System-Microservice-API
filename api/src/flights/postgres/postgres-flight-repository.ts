import { In, type DataSource, type EntityManager } from "typeorm";

import { AirportEntity } from "../../airports/postgres/airport.entity.js";
import {
  isDeadlockDetected,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../postgres/postgres-errors.js";
import {
  isInTransaction,
  resolveEntityManager,
} from "../../postgres/transaction-context.js";
import { type Money, parseVndFromDatabase } from "../../money/money.js";
import type { Flight, FlightFares } from "../../types.js";
import {
  toStoredFlightStatus,
  type StoredFlightStatus,
} from "../flight-lifecycle.js";
import type {
  ChangeFlightStatusResult,
  CreateFlightRepositoryResult,
  FlightPage,
  FlightPageRequest,
  FlightRepository,
  FlightSeat,
  FlightSeatStatus,
} from "../flight-repository.js";
import { FARE_CLASSES, type FareClass } from "../../aircraft/seat-layout.js";
import { FlightEntity } from "./flight.entity.js";

/**
 * FlightEntity uses Date (TIMESTAMPTZ) and airport ids; the domain Flight
 * type uses ISO strings and also carries the IATA codes. This boundary is the
 * only place that converts between them — neither Flight nor
 * FlightRepository's callers know FlightEntity exists.
 */
function mapFlight(
  { entity, availableSeats }: FlightRow,
  codes: ReadonlyMap<string, string>,
  fares: ReadonlyMap<string, FlightFares>,
): Flight {
  const code = (airportId: string) => {
    const value = codes.get(airportId);
    if (value === undefined) {
      throw new Error(`Airport ${airportId} missing for flight ${entity.id}`);
    }
    return value;
  };

  return {
    id: entity.id,
    flightNumber: entity.flightNumber,
    originAirportId: entity.originAirportId,
    origin: code(entity.originAirportId),
    destinationAirportId: entity.destinationAirportId,
    destination: code(entity.destinationAirportId),
    aircraftId: entity.aircraftId,
    departureAt: entity.departureAt.toISOString(),
    arrivalAt: entity.arrivalAt.toISOString(),
    fares: fares.get(entity.id) ?? {},
    availableSeats,
    status: toStoredFlightStatus(entity.status),
  };
}

type FlightRow = { entity: FlightEntity; availableSeats: number };

/**
 * A correlated subquery, not a join: a flight with no AVAILABLE seat counts
 * 0 instead of dropping out of the result (what an INNER JOIN would do), and
 * the page stays one query however many flights it holds.
 */
const AVAILABLE_SEATS = `(SELECT count(*)::int FROM "flight_seats" "seat"
  WHERE "seat"."flight_id" = "flight"."id" AND "seat"."status" = 'AVAILABLE')`;

function selectFlights(manager: EntityManager) {
  return manager
    .getRepository(FlightEntity)
    .createQueryBuilder("flight")
    .addSelect(AVAILABLE_SEATS, "available_seats");
}

async function loadFlightRows(
  query: ReturnType<typeof selectFlights>,
): Promise<FlightRow[]> {
  const { entities, raw } = await query.getRawAndEntities<{
    flight_id: string;
    available_seats: number;
  }>();
  const counts = new Map(raw.map((row) => [row.flight_id, row.available_seats]));

  return entities.map((entity) => {
    const availableSeats = counts.get(entity.id);
    if (availableSeats === undefined) {
      throw new Error(`available_seats missing for flight ${entity.id}`);
    }
    return { entity, availableSeats };
  });
}

/**
 * One query for the fares of every flight on a page. `amount_vnd` is a
 * bigint, which `pg` returns as a string: parsed here, loudly (Decision 13).
 */
async function loadFares(
  manager: EntityManager,
  flightIds: readonly string[],
): Promise<Map<string, FlightFares>> {
  const rows = (await manager.query(
    `SELECT "flight_id", "fare_class", "amount_vnd" FROM "flight_fares"
     WHERE "flight_id" = ANY($1::uuid[])`,
    [flightIds],
  )) as Array<{ flight_id: string; fare_class: string; amount_vnd: string }>;

  const fares = new Map<string, Partial<Record<FareClass, Money>>>();
  for (const row of rows) {
    const flightFares = fares.get(row.flight_id) ?? {};
    // CHK_flight_fares_fare_class guarantees the value set.
    flightFares[row.fare_class as FareClass] = parseVndFromDatabase(row.amount_vnd);
    fares.set(row.flight_id, flightFares);
  }

  return fares;
}

/** One query for every airport code and one for every fare a page needs. */
async function mapFlights(
  manager: EntityManager,
  rows: FlightRow[],
): Promise<Flight[]> {
  const airportIds = [
    ...new Set(
      rows.flatMap(({ entity }) => [
        entity.originAirportId,
        entity.destinationAirportId,
      ]),
    ),
  ];

  if (airportIds.length === 0) {
    return [];
  }

  const airports = await manager
    .getRepository(AirportEntity)
    .find({ where: { id: In(airportIds) }, select: { id: true, code: true } });
  const codes = new Map(airports.map((airport) => [airport.id, airport.code]));
  const fares = await loadFares(
    manager,
    rows.map(({ entity }) => entity.id),
  );

  return rows.map((row) => mapFlight(row, codes, fares));
}

async function insertFlight(
  manager: EntityManager,
  flight: Flight,
): Promise<CreateFlightRepositoryResult> {
  try {
    await manager.getRepository(FlightEntity).insert({
      id: flight.id,
      flightNumber: flight.flightNumber,
      originAirportId: flight.originAirportId,
      destinationAirportId: flight.destinationAirportId,
      aircraftId: flight.aircraftId,
      departureAt: new Date(flight.departureAt),
      arrivalAt: new Date(flight.arrivalAt),
      status: flight.status,
    });
  } catch (error) {
    if (isUniqueViolation(error, "UQ_flights_flight_number_departure_at")) {
      return { outcome: "duplicate" };
    }

    if (isExclusionViolation(error, "EXCL_flights_aircraft_schedule")) {
      return { outcome: "aircraft-unavailable" };
    }

    // Unlike a unique index, an exclusion constraint has no special path
    // for concurrent inserts: two overlapping flights of one aircraft
    // inserted at once each wait for the other's uncommitted row, and
    // Postgres aborts one with 40P01 instead of 23P01 (race test B).
    // Mapping it to aircraft-unavailable assumes this insert is the first
    // write of CreateFlight's transaction, so that wait is the only cycle
    // it can be in. Anything written after it (the flight's seats) must
    // only touch rows no other transaction can see yet. A write added
    // *before* this insert breaks the assumption: retry instead.
    // If the winner later rolls back too, the slot stays free and this
    // 409 is safe to retry.
    if (isDeadlockDetected(error)) {
      return { outcome: "aircraft-unavailable" };
    }

    if (isForeignKeyViolation(error)) {
      return { outcome: "reference-not-found" };
    }

    throw error;
  }

  // One statement copies the whole layout inside Postgres: no seat list
  // travels through TypeScript, and the copy is the aircraft's layout as
  // this transaction sees it.
  await manager.query(
    `INSERT INTO "flight_seats" ("flight_id", "row", "letter", "fare_class", "status")
     SELECT $1, "row", "letter", "fare_class", 'AVAILABLE'
     FROM "seats" WHERE "aircraft_id" = $2`,
    [flight.id, flight.aircraftId],
  );

  // Rows of this new flight only, like its seats above. Which classes they
  // cover (BR-FLT-09) is the use case's rule, not the repository's.
  const fareClasses = FARE_CLASSES.filter(
    (fareClass) => flight.fares[fareClass] !== undefined,
  );
  await manager.query(
    `INSERT INTO "flight_fares" ("flight_id", "fare_class", "amount_vnd")
     SELECT $1, fare.fare_class, fare.amount_vnd
     FROM unnest($2::text[], $3::bigint[]) AS fare(fare_class, amount_vnd)`,
    [
      flight.id,
      fareClasses,
      fareClasses.map((fareClass) => flight.fares[fareClass]?.amount),
    ],
  );

  return { outcome: "created" };
}

export function createPostgresFlightRepository(
  dataSource: DataSource,
): FlightRepository {
  return {
    async findPage(request: FlightPageRequest): Promise<FlightPage> {
      const manager = resolveEntityManager(dataSource);
      const rows = await loadFlightRows(
        selectFlights(manager)
          .orderBy("flight.departureAt", "ASC")
          .addOrderBy("flight.id", "ASC")
          .limit(request.limit)
          .offset(request.offset),
      );
      const totalItems = await manager.getRepository(FlightEntity).count();

      return {
        items: await mapFlights(manager, rows),
        totalItems,
      };
    },

    async findById(id: string): Promise<Flight | undefined> {
      const manager = resolveEntityManager(dataSource);
      const rows = await loadFlightRows(
        selectFlights(manager).where("flight.id = :id", { id }),
      );

      const [flight] = await mapFlights(manager, rows);
      return flight;
    },

    async findSeats(flightId: string): Promise<FlightSeat[] | undefined> {
      // LEFT JOIN: no row at all means no flight; one row of NULLs means a
      // flight without seats. booking_id is never selected.
      const rows = (await resolveEntityManager(dataSource).query(
        `SELECT seat."row", seat."letter", seat."fare_class", seat."status"
         FROM "flights" flight
         LEFT JOIN "flight_seats" seat ON seat."flight_id" = flight."id"
         WHERE flight."id" = $1
         ORDER BY seat."row", seat."letter"`,
        [flightId],
      )) as Array<{
        row: number | null;
        letter: string | null;
        fare_class: string | null;
        status: string | null;
      }>;

      if (rows.length === 0) {
        return undefined;
      }

      return rows.flatMap(({ row, letter, fare_class, status }) =>
        row === null || letter === null
          ? []
          : [
              {
                position: { row, letter },
                // The CHECK constraints guarantee both value sets.
                fareClass: fare_class as FareClass,
                status: status as FlightSeatStatus,
              },
            ],
      );
    },

    /**
     * Atomic on its own, like AircraftRepository.create(): inside a
     * TransactionRunner it joins that transaction; outside one it opens its
     * own, so a flight is never stored without its seats.
     */
    async create(flight: Flight): Promise<CreateFlightRepositoryResult> {
      if (isInTransaction()) {
        return insertFlight(resolveEntityManager(dataSource), flight);
      }

      return dataSource.transaction((manager) => insertFlight(manager, flight));
    },

    async changeStatus(
      flightId: string,
      expected: StoredFlightStatus,
      next: StoredFlightStatus,
    ): Promise<ChangeFlightStatusResult> {
      const manager = resolveEntityManager(dataSource);

      const result = await manager
        .createQueryBuilder()
        .update(FlightEntity)
        .set({ status: next })
        .where("id = :id AND status = :expected", { id: flightId, expected })
        .execute();

      if (result.affected === 1) {
        return { outcome: "changed" };
      }

      // Only picks the outcome; the decision was the UPDATE above.
      const current = await manager
        .getRepository(FlightEntity)
        .findOne({ where: { id: flightId }, select: { id: true, status: true } });

      return current === null
        ? { outcome: "not-found" }
        : {
            outcome: "status-changed",
            current: toStoredFlightStatus(current.status),
          };
    },
  };
}
