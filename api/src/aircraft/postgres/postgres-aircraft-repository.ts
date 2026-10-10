import type { DataSource, EntityManager } from "typeorm";

import { isUniqueViolation } from "../../postgres/postgres-errors.js";
import {
  isInTransaction,
  resolveEntityManager,
} from "../../postgres/transaction-context.js";
import type {
  Aircraft,
  AircraftRepository,
  CreateAircraftResult,
} from "../aircraft-repository.js";
import type { FareClass } from "../seat-layout.js";
import { AircraftEntity } from "./aircraft.entity.js";
import { SeatEntity } from "./seat.entity.js";

function mapAircraft(entity: AircraftEntity, seats: SeatEntity[]): Aircraft {
  return {
    id: entity.id,
    registration: entity.registration,
    model: entity.model,
    createdAt: entity.createdAt.toISOString(),
    seats: seats.map((seat) => ({
      position: { row: seat.row, letter: seat.letter },
      // The CHECK constraint guarantees the value set.
      fareClass: seat.fareClass as FareClass,
    })),
  };
}

async function insertAircraft(
  manager: EntityManager,
  aircraft: Aircraft,
): Promise<CreateAircraftResult> {
  try {
    await manager.getRepository(AircraftEntity).insert({
      id: aircraft.id,
      registration: aircraft.registration,
      model: aircraft.model,
      createdAt: new Date(aircraft.createdAt),
    });
  } catch (error) {
    if (isUniqueViolation(error, "UQ_aircraft_registration")) {
      return { outcome: "duplicate" };
    }

    throw error;
  }

  // One multi-row INSERT for the whole layout, not one statement per seat.
  // A duplicate position violates PK_seats and throws (programmer error).
  await manager.getRepository(SeatEntity).insert(
    aircraft.seats.map((seat) => ({
      aircraftId: aircraft.id,
      row: seat.position.row,
      letter: seat.position.letter,
      fareClass: seat.fareClass,
    })),
  );

  return { outcome: "created" };
}

export function createPostgresAircraftRepository(
  dataSource: DataSource,
): AircraftRepository {
  return {
    /**
     * Atomic on its own: inside a TransactionRunner it joins that
     * transaction (so a later failure in the use case rolls the aircraft
     * back too); called outside one (the seed script), it opens its own, so
     * an aircraft can never be stored without its seats.
     */
    async create(aircraft: Aircraft): Promise<CreateAircraftResult> {
      if (isInTransaction()) {
        return insertAircraft(resolveEntityManager(dataSource), aircraft);
      }

      return dataSource.transaction((manager) =>
        insertAircraft(manager, aircraft),
      );
    },

    async findById(id: string): Promise<Aircraft | undefined> {
      return findOneWithSeats(resolveEntityManager(dataSource), { id });
    },

    async findByRegistration(
      registration: string,
    ): Promise<Aircraft | undefined> {
      return findOneWithSeats(resolveEntityManager(dataSource), {
        registration,
      });
    },
  };
}

async function findOneWithSeats(
  manager: EntityManager,
  where: { id: string } | { registration: string },
): Promise<Aircraft | undefined> {
  const entity = await manager.getRepository(AircraftEntity).findOneBy(where);

  if (entity === null) {
    return undefined;
  }

  const seats = await manager.getRepository(SeatEntity).find({
    where: { aircraftId: entity.id },
    order: { row: "ASC", letter: "ASC" },
  });

  return mapAircraft(entity, seats);
}
