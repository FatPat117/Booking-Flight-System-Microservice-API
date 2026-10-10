import type { DataSource } from "typeorm";

import { isUniqueViolation } from "../../postgres/postgres-errors.js";
import { resolveEntityManager } from "../../postgres/transaction-context.js";
import type {
  Airport,
  AirportPage,
  AirportPageRequest,
  AirportRepository,
  CreateAirportResult,
} from "../airport-repository.js";
import { AirportEntity } from "./airport.entity.js";

function mapAirport(entity: AirportEntity): Airport {
  return {
    id: entity.id,
    code: entity.code,
    name: entity.name,
    city: entity.city,
    timeZone: entity.timeZone,
    createdAt: entity.createdAt.toISOString(),
  };
}

export function createPostgresAirportRepository(
  dataSource: DataSource,
): AirportRepository {
  return {
    async create(airport: Airport): Promise<CreateAirportResult> {
      const repository =
        resolveEntityManager(dataSource).getRepository(AirportEntity);

      try {
        await repository.insert({
          ...airport,
          createdAt: new Date(airport.createdAt),
        });
        return { outcome: "created" };
      } catch (error) {
        if (isUniqueViolation(error, "UQ_airports_code")) {
          return { outcome: "duplicate" };
        }

        throw error;
      }
    },

    async findPage(request: AirportPageRequest): Promise<AirportPage> {
      const repository =
        resolveEntityManager(dataSource).getRepository(AirportEntity);
      const [entities, totalItems] = await repository.findAndCount({
        order: { code: "ASC" },
        take: request.limit,
        skip: request.offset,
      });

      return { items: entities.map(mapAirport), totalItems };
    },

    async findByCode(code: string): Promise<Airport | undefined> {
      const entity = await resolveEntityManager(dataSource)
        .getRepository(AirportEntity)
        .findOneBy({ code });

      return entity === null ? undefined : mapAirport(entity);
    },
  };
}
