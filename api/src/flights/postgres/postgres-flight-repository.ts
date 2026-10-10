import { In, type DataSource, type EntityManager } from "typeorm";

import { AirportEntity } from "../../airports/postgres/airport.entity.js";
import {
  isDeadlockDetected,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../postgres/postgres-errors.js";
import { resolveEntityManager } from "../../postgres/transaction-context.js";
import type { Flight } from "../../types.js";
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
} from "../flight-repository.js";
import { FlightEntity } from "./flight.entity.js";

/**
 * FlightEntity uses Date (TIMESTAMPTZ) and airport ids; the domain Flight
 * type uses ISO strings and also carries the IATA codes. This boundary is the
 * only place that converts between them — neither Flight nor
 * FlightRepository's callers know FlightEntity exists.
 */
function mapFlight(
  entity: FlightEntity,
  codes: ReadonlyMap<string, string>,
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
    priceInCents: entity.priceInCents,
    currency: entity.currency,
    availableSeats: entity.availableSeats,
    status: toStoredFlightStatus(entity.status),
  };
}

/** One query for every airport code a page of flights needs. */
async function mapFlights(
  manager: EntityManager,
  entities: FlightEntity[],
): Promise<Flight[]> {
  const airportIds = [
    ...new Set(
      entities.flatMap((entity) => [
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

  return entities.map((entity) => mapFlight(entity, codes));
}

export function createPostgresFlightRepository(
  dataSource: DataSource,
): FlightRepository {
  return {
    async findPage(request: FlightPageRequest): Promise<FlightPage> {
      const manager = resolveEntityManager(dataSource);
      const [entities, totalItems] = await manager
        .getRepository(FlightEntity)
        .findAndCount({
          order: { departureAt: "ASC", id: "ASC" },
          take: request.limit,
          skip: request.offset,
        });

      return {
        items: await mapFlights(manager, entities),
        totalItems,
      };
    },

    async findById(id: string): Promise<Flight | undefined> {
      const manager = resolveEntityManager(dataSource);
      const entity = await manager.getRepository(FlightEntity).findOneBy({ id });

      if (entity === null) {
        return undefined;
      }

      const [flight] = await mapFlights(manager, [entity]);
      return flight;
    },

    async create(flight: Flight): Promise<CreateFlightRepositoryResult> {
      const repository =
        resolveEntityManager(dataSource).getRepository(FlightEntity);

      try {
        await repository.insert({
          id: flight.id,
          flightNumber: flight.flightNumber,
          originAirportId: flight.originAirportId,
          destinationAirportId: flight.destinationAirportId,
          aircraftId: flight.aircraftId,
          departureAt: new Date(flight.departureAt),
          arrivalAt: new Date(flight.arrivalAt),
          priceInCents: flight.priceInCents,
          currency: flight.currency,
          availableSeats: flight.availableSeats,
          status: flight.status,
        });
        return { outcome: "created" };
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
        // The insert is the first write of CreateFlight's transaction, so that
        // wait is the only cycle it can be in. If the winner later rolls back
        // too, the slot stays free and this 409 is safe to retry.
        if (isDeadlockDetected(error)) {
          return { outcome: "aircraft-unavailable" };
        }

        if (isForeignKeyViolation(error)) {
          return { outcome: "reference-not-found" };
        }

        throw error;
      }
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
