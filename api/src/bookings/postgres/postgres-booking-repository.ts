import { In, type DataSource, type EntityManager } from "typeorm";

import type { FareClass } from "../../aircraft/seat-layout.js";
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
import { onSaleSql } from "../../flights/postgres/on-sale-sql.js";
import { parseVndFromDatabase } from "../../money/money.js";
import { classifyNotCancelled } from "../booking-lifecycle.js";
import { bookingTotal } from "../booking-total.js";
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
  ChangeSeatResult,
  CreateBookingRepositoryResult,
  ExpiredHold,
  HeldSeat,
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
    total: bookingTotal(passengers),
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
    // CHK_booking_passengers_fare_class guarantees the value set.
    fareClass: entity.fareClass as FareClass | null,
    price:
      entity.priceVnd === null ? null : parseVndFromDatabase(entity.priceVnd),
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
        fareClass: passenger.fareClass,
        priceVnd:
          passenger.price === null ? null : String(passenger.price.amount),
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
 * The flight's fares, share-locked, as a CTE of both hold statements
 * (Decision 13, BR-BOOK-03). Changing a fare is an UPDATE of these rows,
 * which needs them exclusively: it waits for a hold in progress, and a hold
 * that reaches them after an uncommitted change waits for that change and
 * then reads its committed values (READ COMMITTED re-reads a row it had to
 * wait for). Either way every seat of one hold is priced from one version
 * of the fares. The flight row's `FOR SHARE` does not cover this: it
 * conflicts with `UPDATE flights`, not `UPDATE flight_fares`.
 *
 * Postgres runs a plain-SELECT CTE only when the query reads it, so each
 * statement must join it, not just declare it.
 */
const SHARE_LOCKED_FARES = `fares AS (
       SELECT "fare_class", "amount_vnd" FROM "flight_fares"
       WHERE "flight_id" = $1
       FOR SHARE
     )`;

type PricedSeatRow = SeatPosition & {
  fare_class: string;
  amount_vnd: string | null;
};

/**
 * A seat with no fare for its class means BR-FLT-09 is broken for this
 * flight. It throws, rolling the hold back: answering not-enough-seats would
 * hide it, and holding the seat would book it without a price.
 */
function toHeldSeat(flightId: string, row: PricedSeatRow): HeldSeat {
  if (row.amount_vnd === null) {
    throw new Error(
      `Flight ${flightId} has no ${row.fare_class} fare for seat ${formatSeatPosition(row)} (BR-FLT-09)`,
    );
  }

  return {
    seat: formatSeatPosition(row),
    // CHK_flight_seats_fare_class guarantees the value set.
    fareClass: row.fare_class as FareClass,
    price: parseVndFromDatabase(row.amount_vnd),
  };
}

/**
 * The `count` lowest free seats of one fare class (Decision 17), in one
 * statement (ADR-004 addendum):
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
 * - Prices: each held seat joined to its class's fare, share-locked in the
 *   same statement (SHARE_LOCKED_FARES).
 */
async function holdAutoSeats(
  manager: EntityManager,
  flightId: string,
  bookingId: string,
  count: number,
  fareClass: FareClass,
  now: Date,
): Promise<HoldSeatsResult> {
  const held = (await manager.query(
    `WITH candidates AS (
       SELECT seat."flight_id", seat."row", seat."letter"
       FROM "flight_seats" seat
       JOIN "flights" flight ON flight."id" = seat."flight_id"
       WHERE seat."flight_id" = $1 AND seat."status" = 'AVAILABLE'
         AND seat."fare_class" = $5
         AND ${onSaleSql("flight", "$3")}
       ORDER BY seat."row", seat."letter"
       LIMIT $4
       FOR UPDATE OF seat SKIP LOCKED
       FOR SHARE OF flight
     ), enough AS (
       SELECT count(*) = $4 AS ok FROM candidates
     ), held AS (
       UPDATE "flight_seats" seat
       SET "status" = 'HELD', "booking_id" = $2
       FROM candidates, enough
       WHERE enough.ok
         AND (seat."flight_id", seat."row", seat."letter")
           = (candidates."flight_id", candidates."row", candidates."letter")
       RETURNING seat."row", seat."letter", seat."fare_class"
     ), ${SHARE_LOCKED_FARES}
     SELECT held."row", held."letter", held."fare_class", fares."amount_vnd"
     FROM held
     LEFT JOIN fares ON fares."fare_class" = held."fare_class"`,
    [flightId, bookingId, now, count, fareClass],
  )) as PricedSeatRow[];

  if (held.length > 0) {
    // RETURNING has no order; passengers get seats front to back.
    return {
      outcome: "held",
      seats: [...held]
        .sort(bySeatOrder)
        .map((row) => toHeldSeat(flightId, row)),
    };
  }

  const reason = await classifyNothingHeld(manager, flightId, now);
  if (reason !== "bookable") {
    return { outcome: reason };
  }
  const [hasClass] = (await manager.query(
    `SELECT 1 FROM "flight_seats" WHERE "flight_id" = $1 AND "fare_class" = $2 LIMIT 1`,
    [flightId, fareClass],
  )) as unknown[];
  return hasClass === undefined
    ? { outcome: "fare-class-not-on-flight" }
    : { outcome: "not-enough-seats" };
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
 *   with its status, so the caller learns which seats were in the way —
 *   and, joined to SHARE_LOCKED_FARES, its fare, used when all were held.
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
       SELECT seat."row", seat."letter"::text AS "letter", seat."status", seat."fare_class"
       FROM "flight_seats" seat
       JOIN "flights" flight ON flight."id" = seat."flight_id"
       WHERE seat."flight_id" = $1
         AND (seat."row", seat."letter"::text) IN (SELECT "row", "letter" FROM requested)
         AND ${onSaleSql("flight", "$5")}
       -- Keep: the global lock order. No test can see it go, because the
       -- current plan sorts the IN list anyway (Day 48A mutation survived).
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
     ), ${SHARE_LOCKED_FARES}
     SELECT locked."row", locked."letter", locked."status", locked."fare_class",
            fares."amount_vnd",
            (SELECT count(*) FROM held)::int AS "held"
     FROM locked
     LEFT JOIN fares ON fares."fare_class" = locked."fare_class"`,
    [
      flightId,
      requested.map((seat) => seat.row),
      requested.map((seat) => seat.letter),
      bookingId,
      now,
      requested.length,
    ],
  )) as Array<PricedSeatRow & { status: string; held: number }>;

  const codes = requested.map(formatSeatPosition);

  if (rows.length > 0 && (rows[0]?.held ?? 0) > 0) {
    // In the request's order, so passenger n gets the seat they named.
    const byCode = new Map(rows.map((row) => [formatSeatPosition(row), row]));
    return {
      outcome: "held",
      seats: codes.map((code) => toHeldSeat(flightId, byCode.get(code) as PricedSeatRow)),
    };
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

/**
 * Two CTEs that change every seat of the bookings in CTE `source` (it must
 * expose "id"), shared by cancel(), expireDueHolds() (Decision 12) and
 * confirmHold() (Decision 14):
 * - `locked` locks the seats in (flight, row, letter) order before anything
 *   updates them — the order a chosen-seat hold locks seats in
 *   (holdChosenSeats), whatever their status. `UPDATE … WHERE booking_id`
 *   alone would lock them in scan order, and a hold holding 12A and waiting
 *   for 12B could meet a release holding 12B and waiting for 12A: 40P01.
 * - `changed` updates exactly the rows `locked` already holds. `letter`
 *   keeps its column type in `locked`, so this join can use PK_flight_seats
 *   instead of comparing a cast.
 * Callers read seats from `locked`, not the table: every CTE sees the
 * snapshot from before the statement's own writes.
 */
function updateSeatsOf(source: string, assignments: string): string {
  return `locked AS (
       SELECT seat."flight_id", seat."row", seat."letter", seat."booking_id"
       FROM "flight_seats" seat
       WHERE seat."booking_id" IN (SELECT "id" FROM ${source})
       ORDER BY seat."flight_id", seat."row", seat."letter"
       FOR UPDATE
     ), changed AS (
       UPDATE "flight_seats" seat
       SET ${assignments}
       FROM locked
       WHERE seat."flight_id" = locked."flight_id"
         AND seat."row" = locked."row" AND seat."letter" = locked."letter"
     )`;
}

function releaseSeatsOf(source: string): string {
  return updateSeatsOf(source, `"status" = 'AVAILABLE', "booking_id" = NULL`);
}

type LockedSeatRow = SeatPosition & {
  status: string;
  booking_id: string | null;
  fare_class: string;
};

/**
 * changeSeat's body, inside a transaction. Three reads, each a lock taken in
 * the global order, then the writes:
 * 1. The booking `FOR UPDATE` and its flight `FOR SHARE` (cancel takes the
 *    same two). Out of scope reads as missing (BR-AUTH-02).
 * 2. The passenger at `position`; its row is the booking's, already locked.
 * 3. Both seats, current and target, `ORDER BY row, letter FOR UPDATE` —
 *    the order holdChosenSeats and releaseSeatsOf lock seats in, whichever
 *    of the two is "mine". The verdict reads their status and fare class
 *    from these locked rows, never from an earlier read.
 * Separate statements, not one: inside a single statement Postgres does not
 * promise which CTE locks first, and here the order across tables matters.
 */
async function changeSeatInTransaction(
  manager: EntityManager,
  bookingId: string,
  position: number,
  target: SeatPosition,
  scope: BookingAccessScope,
  now: Date,
): Promise<ChangeSeatResult> {
  const [booking] = (await manager.query(
    `SELECT booking."status", booking."flight_id", flight."status" AS "flight_status",
            flight."departure_at"
     FROM "bookings" booking
     JOIN "flights" flight ON flight."id" = booking."flight_id"
     WHERE booking."id" = $1
       ${scope.kind === "owner" ? `AND booking."owner_account_id" = $2` : ""}
     FOR UPDATE OF booking
     FOR SHARE OF flight`,
    scope.kind === "owner" ? [bookingId, scope.accountId] : [bookingId],
  )) as Array<{
    status: string;
    flight_id: string;
    flight_status: string;
    departure_at: Date;
  }>;

  if (booking === undefined) {
    return { outcome: "not-found" };
  }

  const passenger = await manager
    .getRepository(BookingPassengerEntity)
    .findOneBy({ bookingId, position });
  if (passenger === null) {
    return { outcome: "passenger-not-found" };
  }
  if (booking.status !== "CONFIRMED") {
    return { outcome: "not-changeable" };
  }
  if (passenger.seatRow === null || passenger.seatLetter === null) {
    // CHK_booking_passengers_seat: only a legacy CANCELLED booking lacks one.
    throw new Error(`Passenger ${position} of CONFIRMED booking ${bookingId} has no seat`);
  }

  const current: SeatPosition = { row: passenger.seatRow, letter: passenger.seatLetter };
  const from = formatSeatPosition(current);
  const to = formatSeatPosition(target);
  if (from === to) {
    return { outcome: "unchanged" };
  }
  if (
    !isBookable(
      toStoredFlightStatus(booking.flight_status),
      booking.departure_at.toISOString(),
      now,
    )
  ) {
    return { outcome: "sales-closed" };
  }

  const locked = (await manager.query(
    `SELECT seat."row", seat."letter"::text AS "letter", seat."status",
            seat."booking_id", seat."fare_class"
     FROM "flight_seats" seat
     WHERE seat."flight_id" = $1
       AND (seat."row", seat."letter"::text) IN (($2::int, $3::text), ($4::int, $5::text))
     -- The global lock order: what makes A→B and B→A queue, not deadlock.
     ORDER BY seat."row", seat."letter"
     FOR UPDATE`,
    [booking.flight_id, current.row, current.letter, target.row, target.letter],
  )) as LockedSeatRow[];

  const bySeat = new Map(locked.map((row) => [formatSeatPosition(row), row]));
  const own = bySeat.get(from);
  const wanted = bySeat.get(to);
  if (own === undefined || own.booking_id !== bookingId || own.status !== "BOOKED") {
    // The display copy and the inventory disagree (Decision 11): a bug.
    throw new Error(`Seat ${from} is not BOOKED for booking ${bookingId}`);
  }
  if (wanted === undefined) {
    return { outcome: "unknown-seat" };
  }
  if (wanted.fare_class !== own.fare_class) {
    return {
      outcome: "fare-class-mismatch",
      // CHK_flight_seats_fare_class guarantees the value set.
      seatFareClass: own.fare_class as FareClass,
      targetFareClass: wanted.fare_class as FareClass,
    };
  }
  if (wanted.status !== "AVAILABLE") {
    return { outcome: "seat-unavailable" };
  }

  // Free first, then take: CHK_flight_seats_booking holds row by row, and
  // UQ_booking_passengers_seat sees the copy move to a seat no other
  // passenger of this booking has (the target was AVAILABLE).
  await manager.query(
    `UPDATE "flight_seats" SET "status" = 'AVAILABLE', "booking_id" = NULL
     WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3`,
    [booking.flight_id, current.row, current.letter],
  );
  await manager.query(
    `UPDATE "flight_seats" SET "status" = 'BOOKED', "booking_id" = $4
     WHERE "flight_id" = $1 AND "row" = $2 AND "letter" = $3`,
    [booking.flight_id, target.row, target.letter, bookingId],
  );
  await manager.getRepository(BookingPassengerEntity).update(
    { id: passenger.id },
    { seatRow: target.row, seatLetter: target.letter },
  );

  return { outcome: "changed", from, to };
}

/**
 * cancel()'s body, inside a transaction. Two statements, in the lock order
 * of the domain-model table: the flight FOR SHARE and the booking FOR
 * UPDATE first, then the cancel itself.
 *
 * The first statement exists for the seat change (Day 50, race test C). In
 * READ COMMITTED a statement reads the snapshot taken when it started, and
 * the cancel statement finds the booking's seats by booking_id in that
 * snapshot. Started while a seat change held the booking, it would wait,
 * then cancel the booking and release the seats the booking had *before*
 * the change — the old seat, already free — leaving the new seat BOOKED
 * for a cancelled booking. Taking the booking's lock in a statement of its
 * own makes the cancel statement start after any change has committed, so
 * it sees the seats as they are.
 */
async function cancelInTransaction(
  manager: EntityManager,
  bookingId: string,
  scope: BookingAccessScope,
  now: Date,
): Promise<CancelBookingRepositoryResult> {
  // Only a booking this call will cancel is locked: the same condition as
  // the UPDATE below. A lapsed hold is left unlocked, so the expiry job's
  // SKIP LOCKED sweep is not turned away by a cancel that will answer
  // `expired` anyway (Day 48B race test C).
  await manager.query(
    `SELECT 1 FROM "bookings" booking
     JOIN "flights" flight ON flight."id" = booking."flight_id"
     WHERE booking."id" = $1
       AND ((booking."status" = 'CONFIRMED'
             AND flight."departure_at" - interval '24 hours' > $2)
            OR (booking."status" = 'HELD' AND booking."hold_expires_at" > $2))
       ${scope.kind === "owner" ? `AND booking."owner_account_id" = $3` : ""}
     FOR UPDATE OF booking
     FOR SHARE OF flight`,
    scope.kind === "owner" ? [bookingId, now, scope.accountId] : [bookingId, now],
  );

  // One statement, two writes: the seats are released only for the row
  // the first UPDATE actually cancelled, so a losing concurrent cancel
  // or a concurrent expiry (the loser re-checks the WHERE after waiting
  // and matches nothing) releases nothing either. `> $2` is the
  // still-valid side of BR-BOOK-10 (expireDueHolds takes `<=`) and of
  // BR-BOOK-06 (Day 50). `flight` share-locks the flight row before the
  // booking, as the hold does, so a departure change waits for this
  // cancel instead of slipping between its check and its write.
  const ownerCondition =
    scope.kind === "owner" ? `AND booking."owner_account_id" = $3` : "";
  const rows = (await manager.query(
    `WITH flight AS (
       SELECT "id", "departure_at" FROM "flights"
       WHERE "id" = (SELECT "flight_id" FROM "bookings" WHERE "id" = $1)
       FOR SHARE
     ), cancelled AS (
       UPDATE "bookings" booking SET "status" = 'CANCELLED'
       FROM flight
       WHERE booking."id" = $1 AND booking."flight_id" = flight."id"
         AND ((booking."status" = 'CONFIRMED'
               AND flight."departure_at" - interval '24 hours' > $2)
              OR (booking."status" = 'HELD' AND booking."hold_expires_at" > $2))
         ${ownerCondition}
       RETURNING booking."id", booking."flight_id", booking."reference"
     ), ${releaseSeatsOf("cancelled")}
     SELECT cancelled."flight_id", cancelled."reference",
            coalesce(
              array_agg(locked."row" || locked."letter" ORDER BY locked."row", locked."letter")
                FILTER (WHERE locked."row" IS NOT NULL),
              '{}'
            ) AS "seats"
     FROM cancelled
     LEFT JOIN locked ON locked."booking_id" = cancelled."id"
     GROUP BY cancelled."flight_id", cancelled."reference"`,
    scope.kind === "owner"
      ? [bookingId, now, scope.accountId]
      : [bookingId, now],
  )) as Array<{ flight_id: string; reference: string; seats: string[] }>;

  const [cancelled] = rows;
  if (cancelled !== undefined) {
    return {
      outcome: "cancelled",
      flightId: cancelled.flight_id,
      reference: cancelled.reference,
      seats: cancelled.seats,
    };
  }

  // Only picks the error outcome; scoped like every read (BR-AUTH-02).
  const [booking] = (await manager.query(
    `SELECT booking."status", booking."hold_expires_at", flight."departure_at"
     FROM "bookings" booking
     JOIN "flights" flight ON flight."id" = booking."flight_id"
     WHERE booking."id" = $1
       ${scope.kind === "owner" ? `AND booking."owner_account_id" = $2` : ""}`,
    scope.kind === "owner" ? [bookingId, scope.accountId] : [bookingId],
  )) as Array<{ status: string; hold_expires_at: Date | null; departure_at: Date }>;

  if (booking === undefined) {
    return { outcome: "not-found" };
  }

  return classifyNotCancelled(
    booking.status as BookingStatus,
    booking.hold_expires_at?.toISOString() ?? null,
    booking.departure_at.toISOString(),
    now,
  );
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
        ? holdAutoSeats(manager, flightId, bookingId, request.count, request.fareClass, now)
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

    async changeSeat(bookingId, position, seat, scope, now) {
      if (isInTransaction()) {
        return changeSeatInTransaction(
          resolveEntityManager(dataSource), bookingId, position, seat, scope, now,
        );
      }

      return dataSource.transaction((manager) =>
        changeSeatInTransaction(manager, bookingId, position, seat, scope, now),
      );
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

    /**
     * Atomic on its own, like create(): the lock statement and the cancel
     * statement must share one transaction.
     */
    async cancel(
      bookingId: string,
      scope: BookingAccessScope,
      now: Date,
    ): Promise<CancelBookingRepositoryResult> {
      if (isInTransaction()) {
        return cancelInTransaction(resolveEntityManager(dataSource), bookingId, scope, now);
      }

      return dataSource.transaction((manager) =>
        cancelInTransaction(manager, bookingId, scope, now),
      );
    },

    /**
     * One statement:
     * - `due` locks the batch with SKIP LOCKED: a booking a cancel or another
     *   sweeper holds right now is skipped, never waited for. A row that was
     *   changed and committed after our snapshot is re-checked against the
     *   WHERE before it is locked, so a just-cancelled booking drops out.
     *   Served by idx_bookings_held_expiry in order (Day 48B Step 2).
     * - `expired` flips only the rows `due` locked.
     * - `locked` / `released` free their seats in lock order (releaseSeatsOf).
     *   They find seats by booking_id in the statement's snapshot, which is
     *   safe because a HELD booking's seats never change (Day 51 audit, see
     *   confirmHold).
     */
    async expireDueHolds(now: Date, limit: number): Promise<ExpiredHold[]> {
      const manager = resolveEntityManager(dataSource);

      const rows = (await manager.query(
        `WITH due AS (
           SELECT "id" FROM "bookings"
           WHERE "status" = 'HELD' AND "hold_expires_at" <= $1
           ORDER BY "hold_expires_at", "id"
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ), expired AS (
           UPDATE "bookings" booking SET "status" = 'EXPIRED'
           FROM due WHERE booking."id" = due."id"
           RETURNING booking."id", booking."reference", booking."flight_id",
                     booking."owner_account_id", booking."hold_expires_at"
         ), ${releaseSeatsOf("expired")}
         SELECT expired."id", expired."reference", expired."flight_id",
                expired."owner_account_id", expired."hold_expires_at",
                coalesce(
                  array_agg(locked."row" || locked."letter" ORDER BY locked."row", locked."letter")
                    FILTER (WHERE locked."row" IS NOT NULL),
                  '{}'
                ) AS "seats"
         FROM expired
         LEFT JOIN locked ON locked."booking_id" = expired."id"
         GROUP BY expired."id", expired."reference", expired."flight_id",
                  expired."owner_account_id", expired."hold_expires_at"
         ORDER BY expired."hold_expires_at", expired."id"`,
        [now, limit],
      )) as Array<{
        id: string;
        reference: string;
        flight_id: string;
        owner_account_id: string;
        hold_expires_at: Date;
        seats: string[];
      }>;

      return rows.map((row) => ({
        bookingId: row.id,
        reference: row.reference,
        flightId: row.flight_id,
        ownerAccountId: row.owner_account_id,
        holdExpiresAt: row.hold_expires_at.toISOString(),
        seats: row.seats,
      }));
    },

    // One statement, like cancel(): the seats are booked only for the row
    // the booking UPDATE actually confirmed, so a payment that lost to a
    // cancel or the expiry job (it re-checks the WHERE after waiting and
    // matches nothing) touches no seat. `> $2` is BR-BOOK-10's still-valid
    // side, at phase 3's own instant.
    // No pre-lock, unlike cancel(): after waiting for the booking lock the
    // seat CTE still finds seats by booking_id in its old snapshot. That is
    // correct only while a HELD booking's seats never change (seat change is
    // CONFIRMED-only). The control in postgres-snapshot-audit.integration.test.ts
    // shows what breaks if that ever changes (Day 51).
    async confirmHold(bookingId, scope, now) {
      const manager = resolveEntityManager(dataSource);
      const ownerCondition =
        scope.kind === "owner" ? `AND "owner_account_id" = $3` : "";
      const rows = (await manager.query(
        `WITH confirmed AS (
           UPDATE "bookings" SET "status" = 'CONFIRMED'
           WHERE "id" = $1 AND "status" = 'HELD' AND "hold_expires_at" > $2
             ${ownerCondition}
           RETURNING "id"
         ), ${updateSeatsOf("confirmed", `"status" = 'BOOKED'`)}
         SELECT "id" FROM confirmed`,
        scope.kind === "owner"
          ? [bookingId, now, scope.accountId]
          : [bookingId, now],
      )) as Array<{ id: string }>;

      if (rows.length === 0) {
        return { outcome: "not-payable" };
      }

      const entity = await manager
        .getRepository(BookingEntity)
        .findOneByOrFail({ id: bookingId });
      const [booking] = await mapBookings(manager, [entity]);
      return { outcome: "confirmed", booking: booking as Booking };
    },
  };
}
