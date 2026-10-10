import type { DataSource } from "typeorm";

import {
  isBookable,
  toStoredFlightStatus,
} from "../../flights/flight-lifecycle.js";
import { FlightEntity } from "../../flights/postgres/flight.entity.js";
import { resolveEntityManager } from "../../postgres/transaction-context.js";
import type {
  Booking,
  BookingAccessScope,
  BookingPage,
  BookingPageRequest,
  BookingRepository,
  BookingStatus,
  CancelBookingRepositoryResult,
  ReserveSeatResult,
} from "../booking-repository.js";
import { BookingEntity } from "./booking.entity.js";

/**
 * Scope as a find-options filter. Every booking read goes through this —
 * including cancel()'s follow-up read, which would otherwise answer
 * already-cancelled for another account's booking and confirm it exists
 * (BR-AUTH-02). cancel()'s UPDATE applies the same scope as an explicit
 * andWhere, since query-builder conditions are SQL, not find options.
 */
function scopeFilter(
  scope: BookingAccessScope,
): { ownerAccountId: string } | Record<string, never> {
  return scope.kind === "owner" ? { ownerAccountId: scope.accountId } : {};
}

function mapBooking(entity: BookingEntity): Booking {
  return {
    id: entity.id,
    flightId: entity.flightId,
    ownerAccountId: entity.ownerAccountId,
    passengerName: entity.passengerName,
    createdAt: entity.createdAt.toISOString(),
    status: entity.status as BookingStatus,
  };
}

export function createPostgresBookingRepository(
  dataSource: DataSource,
): BookingRepository {
  return {
    async reserveSeat(flightId: string, now: Date): Promise<ReserveSeatResult> {
      const manager = resolveEntityManager(dataSource);

      // `available_seats - 1` is computed in SQL, not read out and
      // subtracted in TypeScript — the whole point of a conditional UPDATE
      // (ADR-004) is that "check" and "write" are one statement, evaluated
      // against the row's latest version after waiting for its lock.
      // Day 46: the sales window (BR-FLT-06) is part of the same condition,
      // the SQL twin of isBookable() — a flight cannot close between a check
      // and the write.
      const result = await manager
        .createQueryBuilder()
        .update(FlightEntity)
        .set({ availableSeats: () => '"available_seats" - 1' })
        .where(
          `id = :id AND available_seats > 0 AND status = 'OPEN'
           AND departure_at - interval '1 hour' > :now`,
          { id: flightId, now },
        )
        .execute();

      if (result.affected === 1) {
        return { outcome: "reserved" };
      }

      // Only picks the outcome; the decision was the UPDATE above.
      const flight = await manager.getRepository(FlightEntity).findOneBy({
        id: flightId,
      });

      if (flight === null) {
        return { outcome: "flight-not-found" };
      }

      if (
        !isBookable(
          toStoredFlightStatus(flight.status),
          flight.departureAt.toISOString(),
          now,
        )
      ) {
        return { outcome: "sales-closed" };
      }

      return { outcome: "sold-out" };
    },

    async create(booking: Booking): Promise<void> {
      const repository =
        resolveEntityManager(dataSource).getRepository(BookingEntity);

      const entity = repository.create({
        id: booking.id,
        flightId: booking.flightId,
        ownerAccountId: booking.ownerAccountId,
        passengerName: booking.passengerName,
        createdAt: new Date(booking.createdAt),
        status: booking.status,
      });

      await repository.insert(entity);
    },

    async findById(
      bookingId: string,
      scope: BookingAccessScope,
    ): Promise<Booking | undefined> {
      const entity = await resolveEntityManager(dataSource)
        .getRepository(BookingEntity)
        .findOneBy({ id: bookingId, ...scopeFilter(scope) });

      return entity === null ? undefined : mapBooking(entity);
    },

    async findPage(
      scope: BookingAccessScope,
      request: BookingPageRequest,
    ): Promise<BookingPage> {
      const [entities, totalItems] = await resolveEntityManager(dataSource)
        .getRepository(BookingEntity)
        .findAndCount({
          where: scopeFilter(scope),
          order: { createdAt: "DESC", id: "DESC" },
          take: request.limit,
          skip: request.offset,
        });

      return { items: entities.map(mapBooking), totalItems };
    },

    async cancel(
      bookingId: string,
      scope: BookingAccessScope,
    ): Promise<CancelBookingRepositoryResult> {
      const manager = resolveEntityManager(dataSource);

      const update = manager
        .createQueryBuilder()
        .update(BookingEntity)
        .set({ status: "cancelled" })
        .where("id = :id AND status = 'active'", { id: bookingId });

      if (scope.kind === "owner") {
        update.andWhere("owner_account_id = :accountId", {
          accountId: scope.accountId,
        });
      }

      const result = await update.returning(["flightId"]).execute();

      if (result.affected === 1) {
        const row = result.raw[0] as { flight_id: string };
        return { outcome: "cancelled", flightId: row.flight_id };
      }

      const booking = await manager.getRepository(BookingEntity).findOneBy({
        id: bookingId,
        ...scopeFilter(scope),
      });

      if (booking === null) {
        return { outcome: "not-found" };
      }

      return { outcome: "already-cancelled" };
    },

    async releaseSeat(flightId: string): Promise<void> {
      const manager = resolveEntityManager(dataSource);

      await manager
        .createQueryBuilder()
        .update(FlightEntity)
        .set({ availableSeats: () => '"available_seats" + 1' })
        .where("id = :id", { id: flightId })
        .execute();
    },
  };
}
