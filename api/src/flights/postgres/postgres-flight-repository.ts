import type { DataSource } from "typeorm";

import { resolveEntityManager } from "../../postgres/transaction-context.js";
import type { Flight } from "../../types.js";
import type {
  CreateFlightRepositoryResult,
  FlightPage,
  FlightPageRequest,
  FlightRepository,
} from "../flight-repository.js";
import { FlightEntity } from "./flight.entity.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (error as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * FlightEntity uses Date (TIMESTAMPTZ); the domain Flight type uses ISO
 * strings. This boundary is the only place that converts between them —
 * neither Flight nor FlightRepository's callers know FlightEntity exists.
 */
function mapFlight(entity: FlightEntity): Flight {
  return {
    id: entity.id,
    flightNumber: entity.flightNumber,
    origin: entity.origin,
    destination: entity.destination,
    departureAt: entity.departureAt.toISOString(),
    arrivalAt: entity.arrivalAt.toISOString(),
    priceInCents: entity.priceInCents,
    currency: entity.currency,
    availableSeats: entity.availableSeats,
  };
}

export function createPostgresFlightRepository(
  dataSource: DataSource,
): FlightRepository {
  return {
    async findPage(request: FlightPageRequest): Promise<FlightPage> {
      const repository =
        resolveEntityManager(dataSource).getRepository(FlightEntity);
      const [entities, totalItems] = await repository.findAndCount({
        order: { departureAt: "ASC", id: "ASC" },
        take: request.limit,
        skip: request.offset,
      });

      return {
        items: entities.map(mapFlight),
        totalItems,
      };
    },

    async findById(id: string): Promise<Flight | undefined> {
      const repository =
        resolveEntityManager(dataSource).getRepository(FlightEntity);
      const entity = await repository.findOneBy({ id });
      return entity ? mapFlight(entity) : undefined;
    },

    async create(flight: Flight): Promise<CreateFlightRepositoryResult> {
      const repository =
        resolveEntityManager(dataSource).getRepository(FlightEntity);
      const entity = repository.create({
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

      try {
        await repository.insert(entity);
        return { outcome: "created" };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { outcome: "duplicate" };
        }

        throw error;
      }
    },
  };
}
