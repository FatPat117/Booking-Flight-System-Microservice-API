import type { DataSource } from "typeorm";

import { FlightEntity } from "../../flights/postgres/flight.entity.js";
import { resolveEntityManager } from "../../postgres/transaction-context.js";
import type {
  Booking,
  BookingRepository,
  CancelBookingRepositoryResult,
  ReserveSeatResult,
} from "../booking-repository.js";
import { BookingEntity } from "./booking.entity.js";

export function createPostgresBookingRepository(
  dataSource: DataSource,
): BookingRepository {
  return {
    async reserveSeat(flightId: string): Promise<ReserveSeatResult> {
      const manager = resolveEntityManager(dataSource);

      // `available_seats - 1` is computed in SQL, not read out and
      // subtracted in TypeScript — the whole point of a conditional UPDATE
      // (ADR-004) is that "check" and "write" are one statement, evaluated
      // against the row's latest version after waiting for its lock.
      const result = await manager
        .createQueryBuilder()
        .update(FlightEntity)
        .set({ availableSeats: () => '"available_seats" - 1' })
        .where("id = :id AND available_seats > 0", { id: flightId })
        .execute();

      if (result.affected === 1) {
        return { outcome: "reserved" };
      }

      const flight = await manager.getRepository(FlightEntity).findOneBy({
        id: flightId,
      });

      if (flight === null) {
        return { outcome: "flight-not-found" };
      }

      return { outcome: "sold-out" };
    },

    async create(booking: Booking): Promise<void> {
      const repository =
        resolveEntityManager(dataSource).getRepository(BookingEntity);

      const entity = repository.create({
        id: booking.id,
        flightId: booking.flightId,
        passengerName: booking.passengerName,
        createdAt: new Date(booking.createdAt),
        status: booking.status,
      });

      await repository.insert(entity);
    },

    async cancel(bookingId: string): Promise<CancelBookingRepositoryResult> {
      const manager = resolveEntityManager(dataSource);

      const result = await manager
        .createQueryBuilder()
        .update(BookingEntity)
        .set({ status: "cancelled" })
        .where("id = :id AND status = 'active'", { id: bookingId })
        .returning(["flightId"])
        .execute();

      if (result.affected === 1) {
        const row = result.raw[0] as { flight_id: string };
        return { outcome: "cancelled", flightId: row.flight_id };
      }

      const booking = await manager.getRepository(BookingEntity).findOneBy({
        id: bookingId,
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
