import { In, type DataSource, type EntityManager } from "typeorm";

import {
  formatSeatPosition,
  parseSeatPosition,
  type SeatPosition,
} from "../../aircraft/seat-position.js";
import {
  isBookable,
  toStoredFlightStatus,
} from "../../flights/flight-lifecycle.js";
import { FlightEntity } from "../../flights/postgres/flight.entity.js";
import {
  isInTransaction,
  resolveEntityManager,
} from "../../postgres/transaction-context.js";
import type {
  Booking,
  BookingAccessScope,
  BookingPage,
  BookingPageRequest,
  BookingPassenger,
  BookingRepository,
  BookingStatus,
  CancelBookingRepositoryResult,
  CreateBookingRepositoryResult,
  HoldSeatsResult,
  SeatHoldRequest,
} from "../booking-repository.js";
import { BookingPassengerEntity } from "./booking-passenger.entity.js";
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

function mapBooking(
  entity: BookingEntity,
  passengers: BookingPassenger[],
): Booking {
  return {
    id: entity.id,
    reference: entity.reference,
    flightId: entity.flightId,
    ownerAccountId: entity.ownerAccountId,
    passengers,
    createdAt: entity.createdAt.toISOString(),
    status: entity.status as BookingStatus,
    holdExpiresAt: entity.holdExpiresAt?.toISOString() ?? null,
  };
}

function mapPassenger(entity: BookingPassengerEntity): BookingPassenger {
  return {
    name: entity.name,
    seat:
      entity.seatRow === null || entity.seatLetter === null
        ? null
        : formatSeatPosition({ row: entity.seatRow, letter: entity.seatLetter }),
  };
}

/**
 * One query for the passengers of every booking on a page, not one per
 * booking (UQ_booking_passengers_position serves it: booking_id leads).
 * Pinned by "findPage reads a page in the same number of queries".
 */
async function mapBookings(
  manager: EntityManager,
  entities: BookingEntity[],
): Promise<Booking[]> {
  if (entities.length === 0) {
    return [];
  }

  const rows = await manager.getRepository(BookingPassengerEntity).find({
    where: { bookingId: In(entities.map((entity) => entity.id)) },
    order: { bookingId: "ASC", position: "ASC" },
  });
  const passengers = new Map<string, BookingPassenger[]>();
  for (const row of rows) {
    const list = passengers.get(row.bookingId) ?? [];
    list.push(mapPassenger(row));
    passengers.set(row.bookingId, list);
  }

  return entities.map((entity) =>
    mapBooking(entity, passengers.get(entity.id) ?? []),
  );
}

/**
 * ON CONFLICT names the reference constraint only: a taken reference is the
 * one expected conflict (→ reference-taken, nothing written, transaction
 * still usable). Any other conflict — a duplicate id, a bad FK — still
 * raises, as it should. Catching 23505 instead would leave the transaction
 * aborted, taking the seats already held in it down with the booking.
 */
async function insertBooking(
  manager: EntityManager,
  booking: Booking,
): Promise<CreateBookingRepositoryResult> {
  const inserted = (await manager.query(
    `INSERT INTO "bookings"
       ("id", "reference", "flight_id", "owner_account_id", "status", "created_at", "hold_expires_at")
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT "UQ_bookings_reference" DO NOTHING
     RETURNING "id"`,
    [
      booking.id,
      booking.reference,
      booking.flightId,
      booking.ownerAccountId,
      booking.status,
      new Date(booking.createdAt),
      booking.holdExpiresAt === null ? null : new Date(booking.holdExpiresAt),
    ],
  )) as Array<{ id: string }>;

  if (inserted.length === 0) {
    return { outcome: "reference-taken" };
  }

  await manager.getRepository(BookingPassengerEntity).insert(
    booking.passengers.map((passenger, index) => {
      const seat =
        passenger.seat === null ? undefined : parseSeatPosition(passenger.seat);
      if (passenger.seat !== null && seat === undefined) {
        throw new Error(`Invalid seat code for passenger: ${passenger.seat}`);
      }
      return {
        id: crypto.randomUUID(),
        bookingId: booking.id,
        position: index + 1,
        name: passenger.name,
        seatRow: seat?.row ?? null,
        seatLetter: seat?.letter ?? null,
      };
    }),
  );

  return { outcome: "created" };
}

/**
 * Why nothing was held, when the hold statement found no seat to work on.
 * Only picks the outcome; the decision was the statement before it.
 */
async function classifyNothingHeld(
  manager: EntityManager,
  flightId: string,
  now: Date,
): Promise<"flight-not-found" | "sales-closed" | "bookable"> {
  const flight = await manager.getRepository(FlightEntity).findOneBy({
    id: flightId,
  });

  if (flight === null) {
    return "flight-not-found";
  }

  return isBookable(
    toStoredFlightStatus(flight.status),
    flight.departureAt.toISOString(),
    now,
  )
    ? "bookable"
    : "sales-closed";
}

function bySeatOrder(a: SeatPosition, b: SeatPosition): number {
  return a.row - b.row || a.letter.localeCompare(b.letter);
}

/**
 * The `count` lowest free seats, in one statement (ADR-004 addendum):
 * - SKIP LOCKED: seats other bookings are taking right now are passed over,
 *   so concurrent bookings take different seats instead of queueing.
 * - FOR SHARE OF flight: the sales window (BR-FLT-06, the SQL twin of
 *   isBookable()) is checked against a flight row nobody can change until
 *   this transaction ends; share locks do not block each other.
 * - All or nothing: `enough` is part of the UPDATE's own WHERE. Fewer
 *   candidates than requested → the UPDATE matches no row and nothing is
 *   written. Never "update what we got, then report not-enough": the
 *   transaction would commit and leave those seats HELD by a booking that
 *   is never created (the half-commit trap, ADR-004 appendix of Day 38).
 */
async function holdAutoSeats(
  manager: EntityManager,
  flightId: string,
  bookingId: string,
  count: number,
  now: Date,
): Promise<HoldSeatsResult> {
  const held = (await manager.query(
    `WITH candidates AS (
       SELECT seat."flight_id", seat."row", seat."letter"
       FROM "flight_seats" seat
       JOIN "flights" flight ON flight."id" = seat."flight_id"
       WHERE seat."flight_id" = $1 AND seat."status" = 'AVAILABLE'
         AND flight."status" = 'OPEN'
         AND flight."departure_at" - interval '1 hour' > $3
       ORDER BY seat."row", seat."letter"
       LIMIT $4
       FOR UPDATE OF seat SKIP LOCKED
       FOR SHARE OF flight
     ), enough AS (
       SELECT count(*) = $4 AS ok FROM candidates
     )
     UPDATE "flight_seats" seat
     SET "status" = 'HELD', "booking_id" = $2
     FROM candidates, enough
     WHERE enough.ok
       AND (seat."flight_id", seat."row", seat."letter")
         = (candidates."flight_id", candidates."row", candidates."letter")
     RETURNING seat."row", seat."letter"`,
    [flightId, bookingId, now, count],
  )) as [Array<SeatPosition>, number];

  const seats = held[0];
  if (seats.length > 0) {
    // RETURNING has no order; passengers get seats front to back.
    return {
      outcome: "held",
      seats: [...seats].sort(bySeatOrder).map(formatSeatPosition),
    };
  }

  const reason = await classifyNothingHeld(manager, flightId, now);
  return reason === "bookable"
    ? { outcome: "not-enough-seats" }
    : { outcome: reason };
}

/**
 * Exactly the requested seats, in one statement:
 * - No SKIP LOCKED: skipping a locked seat would silently drop a seat the
 *   customer chose. The statement waits for it, then sees its new status.
 * - Global lock order: `locked` is sorted by (row, letter), and LockRows
 *   sits above the Sort in the plan, so rows are locked in that order
 *   whatever order the request listed them in. Two requests for
 *   [12A, 12B] and [12B, 12A] both queue on 12A first — no lock cycle.
 *   Without the ORDER BY today's plan still happens to sort (it dedupes
 *   the IN list with Unique over Sort), but no plan is promised; ordering
 *   by the request instead deadlocks within this single statement (Day 48A
 *   race test B).
 * - `verdict` requires every requested seat to exist and be AVAILABLE;
 *   `held` updates only then. The final SELECT returns every locked row
 *   with its status, so the caller learns which seats were in the way.
 */
async function holdChosenSeats(
  manager: EntityManager,
  flightId: string,
  bookingId: string,
  requested: readonly SeatPosition[],
  now: Date,
): Promise<HoldSeatsResult> {
  const rows = (await manager.query(
    `WITH requested AS (
       SELECT * FROM unnest($2::int[], $3::text[]) AS r("row", "letter")
     ), locked AS (
       SELECT seat."row", seat."letter"::text AS "letter", seat."status"
       FROM "flight_seats" seat
       JOIN "flights" flight ON flight."id" = seat."flight_id"
       WHERE seat."flight_id" = $1
         AND (seat."row", seat."letter"::text) IN (SELECT "row", "letter" FROM requested)
         AND flight."status" = 'OPEN'
         AND flight."departure_at" - interval '1 hour' > $5
       ORDER BY seat."row", seat."letter"
       FOR UPDATE OF seat
       FOR SHARE OF flight
     ), verdict AS (
       SELECT count(*) = $6 AND bool_and("status" = 'AVAILABLE') AS ok FROM locked
     ), held AS (
       UPDATE "flight_seats" seat
       SET "status" = 'HELD', "booking_id" = $4
       FROM locked, verdict
       WHERE verdict.ok AND seat."flight_id" = $1
         AND seat."row" = locked."row" AND seat."letter" = locked."letter"
       RETURNING seat."row"
     )
     SELECT locked."row", locked."letter", locked."status",
            (SELECT count(*) FROM held)::int AS "held"
     FROM locked`,
    [
      flightId,
      requested.map((seat) => seat.row),
      requested.map((seat) => seat.letter),
      bookingId,
      now,
      requested.length,
    ],
  )) as Array<SeatPosition & { status: string; held: number }>;

  const codes = requested.map(formatSeatPosition);

  if (rows.length > 0 && (rows[0]?.held ?? 0) > 0) {
    return { outcome: "held", seats: codes };
  }

  if (rows.length === 0) {
    const reason = await classifyNothingHeld(manager, flightId, now);
    if (reason !== "bookable") {
      return { outcome: reason };
    }
  }

  // Reported in the request's order, so an error names seats the way the
  // client listed them.
  const found = new Map(rows.map((row) => [formatSeatPosition(row), row.status]));
  const unknown = codes.filter((code) => !found.has(code));
  if (unknown.length > 0) {
    return { outcome: "unknown-seats", seats: unknown };
  }

  return {
    outcome: "seats-unavailable",
    seats: codes.filter((code) => found.get(code) !== "AVAILABLE"),
  };
}

export function createPostgresBookingRepository(
  dataSource: DataSource,
): BookingRepository {
  return {
    async holdSeats(
      flightId: string,
      bookingId: string,
      request: SeatHoldRequest,
      now: Date,
    ): Promise<HoldSeatsResult> {
      const manager = resolveEntityManager(dataSource);

      return request.kind === "auto"
        ? holdAutoSeats(manager, flightId, bookingId, request.count, now)
        : holdChosenSeats(manager, flightId, bookingId, request.seats, now);
    },

    /**
     * Atomic on its own, like AircraftRepository.create: inside a
     * TransactionRunner it joins that transaction; outside one it opens its
     * own, so a booking is never stored without its passengers.
     */
    async create(booking: Booking): Promise<CreateBookingRepositoryResult> {
      if (isInTransaction()) {
        return insertBooking(resolveEntityManager(dataSource), booking);
      }

      return dataSource.transaction((manager) => insertBooking(manager, booking));
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

    async findByReference(
      reference: string,
      scope: BookingAccessScope,
    ): Promise<Booking | undefined> {
      const manager = resolveEntityManager(dataSource);
      const entity = await manager
        .getRepository(BookingEntity)
        .findOneBy({ reference, ...scopeFilter(scope) });

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

      // One statement, two writes: the seats are released only for the row
      // the first UPDATE actually cancelled, so a losing concurrent cancel
      // (which re-checks the status after waiting and matches nothing)
      // releases nothing either. Every seat of the booking: 1–9 rows.
      const ownerCondition =
        scope.kind === "owner" ? `AND "owner_account_id" = $2` : "";
      const rows = (await manager.query(
        `WITH cancelled AS (
           UPDATE "bookings" SET "status" = 'CANCELLED'
           WHERE "id" = $1 AND "status" IN ('HELD', 'CONFIRMED') ${ownerCondition}
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
