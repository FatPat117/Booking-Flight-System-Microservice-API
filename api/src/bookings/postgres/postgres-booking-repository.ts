import type { DataSource, EntityManager } from "typeorm";

import { formatSeatPosition } from "../../aircraft/seat-position.js";
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
 * SQL condition, since its statement is raw SQL, not find options.
 */
function scopeFilter(
  scope: BookingAccessScope,
): { ownerAccountId: string } | Record<string, never> {
  return scope.kind === "owner" ? { ownerAccountId: scope.accountId } : {};
}

function mapBooking(entity: BookingEntity, seat: string | null): Booking {
  return {
    id: entity.id,
    flightId: entity.flightId,
    ownerAccountId: entity.ownerAccountId,
    passengerName: entity.passengerName,
    createdAt: entity.createdAt.toISOString(),
    status: entity.status as BookingStatus,
    seat,
  };
}

/**
 * One query for the seat of every booking on a page (UQ_flight_seats_booking_id
 * serves it). A booking without a row there is cancelled: null, not an error.
 */
async function mapBookings(
  manager: EntityManager,
  entities: BookingEntity[],
): Promise<Booking[]> {
  if (entities.length === 0) {
    return [];
  }

  const rows = (await manager.query(
    `SELECT "booking_id", "row", "letter" FROM "flight_seats" WHERE "booking_id" = ANY($1)`,
    [entities.map((entity) => entity.id)],
  )) as Array<{ booking_id: string; row: number; letter: string }>;
  const seats = new Map(
    rows.map((row) => [row.booking_id, formatSeatPosition(row)]),
  );

  return entities.map((entity) => mapBooking(entity, seats.get(entity.id) ?? null));
}

export function createPostgresBookingRepository(
  dataSource: DataSource,
): BookingRepository {
  return {
    async reserveSeat(
      flightId: string,
      bookingId: string,
      now: Date,
    ): Promise<ReserveSeatResult> {
      const manager = resolveEntityManager(dataSource);

      // Pick and claim in one statement (ADR-004 addendum, Day 47):
      // - SKIP LOCKED: a seat another booking is claiming right now is
      //   passed over, not waited on — twenty callers take twenty different
      //   seats instead of queueing behind each other on the first one.
      // - FOR SHARE OF flight: the sales window (BR-FLT-06, the SQL twin of
      //   isBookable()) is checked against a flight row nobody can change
      //   until this transaction ends. Share locks do not block each other,
      //   so bookings still run in parallel; only a status change waits.
      const rows = (await manager.query(
        `WITH picked AS (
           SELECT seat."flight_id", seat."row", seat."letter"
           FROM "flight_seats" seat
           JOIN "flights" flight ON flight."id" = seat."flight_id"
           WHERE seat."flight_id" = $1 AND seat."status" = 'AVAILABLE'
             AND flight."status" = 'OPEN'
             AND flight."departure_at" - interval '1 hour' > $3
           ORDER BY seat."row", seat."letter"
           LIMIT 1
           FOR UPDATE OF seat SKIP LOCKED
           FOR SHARE OF flight
         )
         UPDATE "flight_seats" seat
         SET "status" = 'BOOKED', "booking_id" = $2
         FROM picked
         WHERE (seat."flight_id", seat."row", seat."letter")
             = (picked."flight_id", picked."row", picked."letter")
         RETURNING seat."row", seat."letter"`,
        [flightId, bookingId, now],
      )) as [Array<{ row: number; letter: string }>, number];

      const [claimed] = rows[0];
      if (claimed !== undefined) {
        return { outcome: "reserved", seat: formatSeatPosition(claimed) };
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
      const manager = resolveEntityManager(dataSource);
      const entity = await manager
        .getRepository(BookingEntity)
        .findOneBy({ id: bookingId, ...scopeFilter(scope) });

      if (entity === null) {
        return undefined;
      }

      const [booking] = await mapBookings(manager, [entity]);
      return booking;
    },

    async findPage(
      scope: BookingAccessScope,
      request: BookingPageRequest,
    ): Promise<BookingPage> {
      const manager = resolveEntityManager(dataSource);
      const [entities, totalItems] = await manager
        .getRepository(BookingEntity)
        .findAndCount({
          where: scopeFilter(scope),
          order: { createdAt: "DESC", id: "DESC" },
          take: request.limit,
          skip: request.offset,
        });

      return { items: await mapBookings(manager, entities), totalItems };
    },

    async cancel(
      bookingId: string,
      scope: BookingAccessScope,
    ): Promise<CancelBookingRepositoryResult> {
      const manager = resolveEntityManager(dataSource);

      // One statement, two writes: the seat is released only for the row the
      // first UPDATE actually cancelled, so a losing concurrent cancel (which
      // re-checks `status = 'active'` after waiting and matches nothing)
      // releases nothing either.
      const ownerCondition =
        scope.kind === "owner" ? `AND "owner_account_id" = $2` : "";
      const rows = (await manager.query(
        `WITH cancelled AS (
           UPDATE "bookings" SET "status" = 'cancelled'
           WHERE "id" = $1 AND "status" = 'active' ${ownerCondition}
           RETURNING "id", "flight_id"
         ), released AS (
           UPDATE "flight_seats" seat
           SET "status" = 'AVAILABLE', "booking_id" = NULL
           FROM cancelled WHERE seat."booking_id" = cancelled."id"
         )
         SELECT "flight_id" FROM cancelled`,
        scope.kind === "owner" ? [bookingId, scope.accountId] : [bookingId],
      )) as Array<{ flight_id: string }>;

      const [cancelled] = rows;
      if (cancelled !== undefined) {
        return { outcome: "cancelled", flightId: cancelled.flight_id };
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
  };
}
