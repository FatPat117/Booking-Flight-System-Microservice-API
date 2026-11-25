import type {
  Aircraft,
  AircraftRepository,
} from "../../src/aircraft/aircraft-repository.js";
import type { RegisterAircraft } from "../../src/aircraft/register-aircraft.js";
import type { FareClass } from "../../src/aircraft/seat-layout.js";
import {
  formatSeatPosition,
  type SeatPosition,
} from "../../src/aircraft/seat-position.js";
import type {
  Airport,
  AirportRepository,
} from "../../src/airports/airport-repository.js";
import type { ListAirports } from "../../src/airports/list-airports.js";
import type { RegisterAirport } from "../../src/airports/register-airport.js";
import type {
  AuditRecorder,
  AuditRecordInput,
} from "../../src/audit/audit-recorder.js";
import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
} from "../../src/bookings/booking-repository.js";
import {
  classifyNotCancelled,
  isCancellationWindowOpen,
  isHoldLapsed,
} from "../../src/bookings/booking-lifecycle.js";
import type { GetBooking } from "../../src/bookings/get-booking.js";
import type { GetBookingByReference } from "../../src/bookings/get-booking-by-reference.js";
import type { ListBookings } from "../../src/bookings/list-bookings.js";
import {
  AIRCRAFT_TURNAROUND_MS,
  isBookable,
} from "../../src/flights/flight-lifecycle.js";
import type {
  FlightRepository,
  FlightSeatStatus,
} from "../../src/flights/flight-repository.js";
import type { FlightSearch, FlightSearchResult } from "../../src/flights/flight-search.js";
import type { GetFlightSeatMap } from "../../src/flights/get-flight-seat-map.js";
import type { CancelFlight } from "../../src/flights/cancel-flight.js";
import type { OpenFlight } from "../../src/flights/open-flight.js";
import type { Money } from "../../src/money/money.js";
import type {
  HealthChecks,
  HealthStatus,
} from "../../src/health/health-checks.js";
import type {
  OutboxEntry,
  OutboxRepository,
} from "../../src/outbox/outbox-repository.js";
import type {
  ClaimResult,
  IdempotencyRepository,
  IdempotencyScope,
  StoredResponse,
} from "../../src/idempotency/idempotency-repository.js";
import type {
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
  RefundRequest,
  RefundResult,
} from "../../src/payments/payment-gateway.js";
import type { PayForBooking } from "../../src/payments/pay-for-booking.js";
import type {
  Payment,
  PaymentRepository,
  PaymentStatus,
} from "../../src/payments/payment-repository.js";
import type { TransactionRunner } from "../../src/transactions/transaction-runner.js";
import type { Flight } from "../../src/types.js";
import { makeSeats, TEST_AIRCRAFT } from "../fixtures/flights.js";
import type {
  AdminReports,
  AuditLogEntry,
  ClassSeats,
  ReportFlight,
} from "../../src/reports/admin-reports.js";
import type { GetFlightManifest } from "../../src/reports/get-flight-manifest.js";
import type { GetLoadFactor } from "../../src/reports/get-load-factor.js";
import type { QueryAuditLog } from "../../src/reports/query-audit-log.js";

/**
 * In-memory fakes for the unit/HTTP test tier (Day 41).
 *
 * They model each port's *business-visible* outcomes (duplicate, sold-out,
 * already-cancelled, ...) the way the Postgres adapters do — the contract
 * tests in tests/contracts/ keep them honest. They do NOT model database
 * semantics (rollback, locking, concurrency): those live in
 * tests/integration/ against real Postgres, where they can actually fail.
 *
 * Every read returns a copy, like a real adapter mapping a fresh row — a
 * test mutating a returned object must not change what is "stored".
 */

/** Mirrors CHK_flight_seats_booking: AVAILABLE exactly when bookingId is null. */
type InMemoryFlightSeat = {
  position: SeatPosition;
  fareClass: FareClass;
  status: FlightSeatStatus;
  bookingId: string | null;
};

/**
 * Shared between the flight and booking fakes: bookings claim and release
 * seats. Like Postgres, a flight stores no seat count — reads count the
 * free seats.
 */
export type InMemoryFlightStore = Readonly<{
  flights: Map<string, Omit<Flight, "availableSeats">>;
  /** Per flight, in (row, letter) order — the order seats are allocated in. */
  seats: Map<string, InMemoryFlightSeat[]>;
}>;

export function createInMemoryFlightStore(): InMemoryFlightStore {
  return { flights: new Map(), seats: new Map() };
}

function toInstant(isoDate: string): number {
  return new Date(isoDate).getTime();
}

/**
 * The first `availableSeats` seats (CreateFlight passes the aircraft's count;
 * a test passes fewer for a small flight, as keepFirstSeats does on
 * Postgres) of a fixture aircraft's layout, so a two-class fixture flight has
 * BUSINESS seats here too. For an aircraft the fixtures do not know
 * (registered by a test), economy rows of six, ABCDEF — the same codes either
 * way.
 */
function generateSeats(flight: Flight): InMemoryFlightSeat[] {
  const layout =
    TEST_AIRCRAFT.find((aircraft) => aircraft.id === flight.aircraftId)?.seats ??
    makeSeats(flight.availableSeats);

  return layout.slice(0, flight.availableSeats).map((seat) => ({
    position: { ...seat.position },
    fareClass: seat.fareClass,
    status: "AVAILABLE",
    bookingId: null,
  }));
}

export function createInMemoryFlightRepository(
  store: InMemoryFlightStore = createInMemoryFlightStore(),
): FlightRepository {
  const { flights, seats } = store;

  const read = (flight: Omit<Flight, "availableSeats">): Flight => ({
    ...structuredClone(flight),
    availableSeats: (seats.get(flight.id) ?? []).filter(
      (seat) => seat.status === "AVAILABLE",
    ).length,
  });

  return {
    async findPage({ limit, offset }) {
      const ordered = [...flights.values()].sort(
        (a, b) =>
          toInstant(a.departureAt) - toInstant(b.departureAt) ||
          a.id.localeCompare(b.id),
      );

      return {
        items: ordered.slice(offset, offset + limit).map(read),
        totalItems: flights.size,
      };
    },

    async findById(id) {
      const flight = flights.get(id);
      return flight === undefined ? undefined : read(flight);
    },

    async findSeats(flightId) {
      if (!flights.has(flightId)) {
        return undefined;
      }

      return (seats.get(flightId) ?? []).map((seat) => ({
        position: { ...seat.position },
        fareClass: seat.fareClass,
        status: seat.status,
      }));
    },

    async create(flight) {
      // Postgres rejects a colliding primary key as an error, not an outcome.
      if (flights.has(flight.id)) {
        throw new Error(`duplicate flight id: ${flight.id}`);
      }

      // Mirrors UNIQUE (flight_number, departure_at), compared as instants
      // (TIMESTAMPTZ), not as strings.
      const isDuplicate = [...flights.values()].some(
        (existing) =>
          existing.flightNumber === flight.flightNumber &&
          toInstant(existing.departureAt) === toInstant(flight.departureAt),
      );

      if (isDuplicate) {
        return { outcome: "duplicate" };
      }

      // Mirrors EXCL_flights_aircraft_schedule: same aircraft, both not
      // CANCELLED, half-open windows [departure, arrival + turnaround) overlap.
      // The flight repository contract runs the boundary cases on both sides.
      const occupies = (candidate: Pick<Flight, "departureAt" | "arrivalAt">) => ({
        from: toInstant(candidate.departureAt),
        until: toInstant(candidate.arrivalAt) + AIRCRAFT_TURNAROUND_MS,
      });
      const window = occupies(flight);
      const clashes =
        flight.status !== "CANCELLED" &&
        [...flights.values()].some((existing) => {
          if (
            existing.aircraftId !== flight.aircraftId ||
            existing.status === "CANCELLED"
          ) {
            return false;
          }
          const other = occupies(existing);
          return window.from < other.until && other.from < window.until;
        });

      if (clashes) {
        return { outcome: "aircraft-unavailable" };
      }

      const { availableSeats, ...stored } = structuredClone(flight);
      flights.set(flight.id, {
        ...stored,
        departureAt: new Date(flight.departureAt).toISOString(),
        arrivalAt: new Date(flight.arrivalAt).toISOString(),
      });
      seats.set(flight.id, generateSeats(flight));
      return { outcome: "created" };
    },

    async changeStatus(flightId, expected, next) {
      const flight = flights.get(flightId);

      if (flight === undefined) {
        return { outcome: "not-found" };
      }
      if (flight.status !== expected) {
        return { outcome: "status-changed", current: flight.status };
      }

      flight.status = next;
      return { outcome: "changed" };
    },
  };
}

export type InMemoryBookingRepository = BookingRepository &
  Readonly<{
    /** Test-only read that bypasses scopes — for asserting stored state. */
    peek(id: string): Booking | undefined;
    /** Test-only: every booking as stored (the AdminReports fake reads them). */
    all(): Booking[];
  }>;

function isInScope(booking: Booking, scope: BookingAccessScope): boolean {
  return scope.kind === "admin" || booking.ownerAccountId === scope.accountId;
}

export function createInMemoryBookingRepository(deps: {
  flights: InMemoryFlightStore;
}): InMemoryBookingRepository {
  const { flights, seats } = deps.flights;
  const bookings = new Map<string, Booking>();
  /** Cancelled flights whose cascade is complete (flights.cascade_completed_at). */
  const completedCancellations = new Set<string>();
  const countLive = (flightId: string, now: Date) =>
    [...bookings.values()].filter(
      (booking) =>
        booking.flightId === flightId &&
        (booking.status === "CONFIRMED" ||
          (booking.status === "HELD" &&
            booking.holdExpiresAt !== null &&
            !isHoldLapsed(booking.holdExpiresAt, now))),
    ).length;

  const read = (booking: Booking): Booking => structuredClone(booking);

  return {
    // Same order of checks as the Postgres adapter: flight, sales window,
    // then (chosen) unknown seats before unavailable ones. Nothing is
    // written unless every requested seat is held.
    async holdSeats(flightId, bookingId, request, now) {
      const flight = flights.get(flightId);

      if (flight === undefined) {
        return { outcome: "flight-not-found" };
      }
      if (!isBookable(flight.status, flight.departureAt, now)) {
        return { outcome: "sales-closed" };
      }

      const flightSeats = seats.get(flightId) ?? [];
      let picked: InMemoryFlightSeat[];

      if (request.kind === "auto") {
        if (!flightSeats.some((seat) => seat.fareClass === request.fareClass)) {
          return { outcome: "fare-class-not-on-flight" };
        }
        picked = flightSeats
          .filter((seat) => seat.status === "AVAILABLE" && seat.fareClass === request.fareClass)
          .slice(0, request.count);
        if (picked.length < request.count) {
          return { outcome: "not-enough-seats" };
        }
      } else {
        const codes = request.seats.map(formatSeatPosition);
        const byCode = new Map(
          flightSeats.map((seat) => [formatSeatPosition(seat.position), seat]),
        );
        const unknown = codes.filter((code) => !byCode.has(code));
        if (unknown.length > 0) {
          return { outcome: "unknown-seats", seats: unknown };
        }
        const unavailable = codes.filter(
          (code) => byCode.get(code)?.status !== "AVAILABLE",
        );
        if (unavailable.length > 0) {
          return { outcome: "seats-unavailable", seats: unavailable };
        }
        picked = codes.map((code) => byCode.get(code) as InMemoryFlightSeat);
      }

      // Same rule as the Postgres hold: a seat whose class has no fare is a
      // broken BR-FLT-09 and throws, before anything is written.
      const priced = picked.map((seat) => {
        const price = flight.fares[seat.fareClass];
        if (price === undefined) {
          throw new Error(
            `Flight ${flightId} has no ${seat.fareClass} fare for seat ${formatSeatPosition(seat.position)} (BR-FLT-09)`,
          );
        }
        return { seat: formatSeatPosition(seat.position), fareClass: seat.fareClass, price };
      });

      for (const seat of picked) {
        seat.status = "HELD";
        seat.bookingId = bookingId;
      }
      return { outcome: "held", seats: priced };
    },

    async create(booking) {
      // Postgres rejects these with a PK / FK violation — a thrown error,
      // not an outcome, because no caller is expected to branch on them.
      if (bookings.has(booking.id)) {
        throw new Error(`duplicate booking id: ${booking.id}`);
      }
      if (!flights.has(booking.flightId)) {
        throw new Error(`booking references unknown flight: ${booking.flightId}`);
      }
      // Mirrors ON CONFLICT ON CONSTRAINT "UQ_bookings_reference" DO NOTHING.
      if ([...bookings.values()].some((stored) => stored.reference === booking.reference)) {
        return { outcome: "reference-taken" };
      }

      bookings.set(booking.id, structuredClone(booking));
      return { outcome: "created" };
    },

    async findById(bookingId, scope) {
      const booking = bookings.get(bookingId);
      return booking === undefined || !isInScope(booking, scope)
        ? undefined
        : read(booking);
    },

    async findByReference(reference, scope) {
      const booking = [...bookings.values()].find(
        (stored) => stored.reference === reference,
      );
      return booking === undefined || !isInScope(booking, scope)
        ? undefined
        : read(booking);
    },

    async findPage(scope, request) {
      const visible = [...bookings.values()]
        .filter((booking) => isInScope(booking, scope))
        .sort(
          (a, b) =>
            toInstant(b.createdAt) - toInstant(a.createdAt) ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );

      return {
        items: visible
          .slice(request.offset, request.offset + request.limit)
          .map(read),
        totalItems: visible.length,
      };
    },

    async cancel(bookingId, scope, now, reason) {
      const booking = bookings.get(bookingId);

      // Out of scope is not-found, never already-cancelled (BR-AUTH-02).
      if (booking === undefined || !isInScope(booking, scope)) {
        return { outcome: "not-found" };
      }
      const flight = flights.get(booking.flightId);
      if (flight === undefined) {
        throw new Error(`Booking ${bookingId} points at a missing flight`);
      }
      // Same condition as the Postgres UPDATE (cancellableSql): HELD still
      // valid at `now` (BR-BOOK-10); CONFIRMED more than 24 h before
      // departure for the customer (BR-BOOK-06), at any time for the
      // airline (BR-FLT-07) — whose cancel needs the flight CANCELLED.
      const heldStillValid =
        booking.status === "HELD" &&
        booking.holdExpiresAt !== null &&
        !isHoldLapsed(booking.holdExpiresAt, now);
      const cancellable =
        reason === "CUSTOMER"
          ? heldStillValid ||
            (booking.status === "CONFIRMED" &&
              isCancellationWindowOpen(flight.departureAt, now))
          : flight.status === "CANCELLED" &&
            (heldStillValid || booking.status === "CONFIRMED");
      if (!cancellable) {
        return classifyNotCancelled(
          booking.status,
          booking.holdExpiresAt,
          flight.departureAt,
          now,
          reason,
          flight.status === "CANCELLED",
        );
      }

      bookings.set(bookingId, { ...booking, status: "CANCELLED", cancellationReason: reason });
      const released: string[] = [];
      for (const seat of seats.get(booking.flightId) ?? []) {
        if (seat.bookingId === bookingId) {
          seat.status = "AVAILABLE";
          seat.bookingId = null;
          released.push(formatSeatPosition(seat.position));
        }
      }
      return {
        outcome: "cancelled",
        flightId: booking.flightId,
        reference: booking.reference,
        seats: released,
      };
    },

    // Same order of checks as the Postgres adapter, so both answer the same
    // outcome when several apply. Nothing to lock: single-threaded.
    async changeSeat(bookingId, position, target, scope, now) {
      const booking = bookings.get(bookingId);
      if (booking === undefined || !isInScope(booking, scope)) {
        return { outcome: "not-found" };
      }
      const passenger = booking.passengers[position - 1];
      if (passenger === undefined) {
        return { outcome: "passenger-not-found" };
      }
      if (booking.status !== "CONFIRMED") {
        return { outcome: "not-changeable" };
      }
      if (passenger.seat === null) {
        throw new Error(`Passenger ${position} of CONFIRMED booking ${bookingId} has no seat`);
      }
      const to = formatSeatPosition(target);
      if (passenger.seat === to) {
        return { outcome: "unchanged" };
      }
      const flight = flights.get(booking.flightId);
      if (flight === undefined || !isBookable(flight.status, flight.departureAt, now)) {
        return { outcome: "sales-closed" };
      }

      const flightSeats = seats.get(booking.flightId) ?? [];
      const own = flightSeats.find((seat) => formatSeatPosition(seat.position) === passenger.seat);
      const wanted = flightSeats.find((seat) => formatSeatPosition(seat.position) === to);
      if (own === undefined || own.bookingId !== bookingId || own.status !== "BOOKED") {
        throw new Error(`Seat ${passenger.seat} is not BOOKED for booking ${bookingId}`);
      }
      if (wanted === undefined) {
        return { outcome: "unknown-seat" };
      }
      if (wanted.fareClass !== own.fareClass) {
        return {
          outcome: "fare-class-mismatch",
          seatFareClass: own.fareClass,
          targetFareClass: wanted.fareClass,
        };
      }
      if (wanted.status !== "AVAILABLE") {
        return { outcome: "seat-unavailable" };
      }

      own.status = "AVAILABLE";
      own.bookingId = null;
      wanted.status = "BOOKED";
      wanted.bookingId = bookingId;
      const passengers = booking.passengers.map((other, index) =>
        index === position - 1 ? { ...other, seat: to } : other,
      );
      bookings.set(bookingId, { ...booking, passengers });
      return { outcome: "changed", from: passenger.seat, to };
    },

    // Same rules as the Postgres sweep: HELD and holdExpiresAt <= now
    // (BR-BOOK-10), oldest deadline first then id, at most `limit`. Nothing
    // to skip: a single-threaded fake never sees a locked row.
    async expireDueHolds(now, limit) {
      const due = [...bookings.values()]
        .filter(
          (booking) =>
            booking.status === "HELD" &&
            booking.holdExpiresAt !== null &&
            toInstant(booking.holdExpiresAt) <= now.getTime(),
        )
        .sort(
          (a, b) =>
            toInstant(a.holdExpiresAt as string) - toInstant(b.holdExpiresAt as string) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, limit);

      return due.map((booking) => {
        bookings.set(booking.id, { ...booking, status: "EXPIRED" });
        const released: string[] = [];
        // Already in (row, letter) order per flight.
        for (const seat of seats.get(booking.flightId) ?? []) {
          if (seat.bookingId === booking.id) {
            seat.status = "AVAILABLE";
            seat.bookingId = null;
            released.push(formatSeatPosition(seat.position));
          }
        }
        return {
          bookingId: booking.id,
          reference: booking.reference,
          flightId: booking.flightId,
          ownerAccountId: booking.ownerAccountId,
          holdExpiresAt: new Date(booking.holdExpiresAt as string).toISOString(),
          seats: released,
        };
      });
    },

    // Same condition as the Postgres UPDATE: in scope, HELD and still valid
    // at `now` (BR-BOOK-10), on a flight that is not CANCELLED (Day 52).
    async confirmHold(bookingId, scope, now) {
      const booking = bookings.get(bookingId);

      if (
        booking === undefined ||
        !isInScope(booking, scope) ||
        flights.get(booking.flightId)?.status === "CANCELLED" ||
        booking.status !== "HELD" ||
        booking.holdExpiresAt === null ||
        isHoldLapsed(booking.holdExpiresAt, now)
      ) {
        return { outcome: "not-payable" };
      }

      const confirmed: Booking = { ...booking, status: "CONFIRMED" };
      bookings.set(bookingId, confirmed);
      for (const seat of seats.get(booking.flightId) ?? []) {
        if (seat.bookingId === bookingId) {
          seat.status = "BOOKED";
        }
      }
      return { outcome: "confirmed", booking: read(confirmed) };
    },

    // No locks here: the fake is single-threaded, so "skip what another
    // transaction holds" never applies. Flight id, then booking id, like Postgres.
    async claimLiveBookingOfCancelledFlight(now) {
      const live = [...bookings.values()]
        .filter(
          (booking) =>
            flights.get(booking.flightId)?.status === "CANCELLED" &&
            !completedCancellations.has(booking.flightId) &&
            (booking.status === "CONFIRMED" ||
              (booking.status === "HELD" &&
                booking.holdExpiresAt !== null &&
                !isHoldLapsed(booking.holdExpiresAt, now))),
        )
        .sort((a, b) => {
          const left = `${a.flightId}/${a.id}`;
          const right = `${b.flightId}/${b.id}`;
          return left < right ? -1 : left > right ? 1 : 0;
        })
        .map((booking) => booking.id);
      return live[0];
    },

    async completeFlightCancellations(now) {
      let completed = 0;
      for (const [flightId, flight] of flights) {
        if (
          flight.status === "CANCELLED" &&
          !completedCancellations.has(flightId) &&
          countLive(flightId, now) === 0
        ) {
          completedCancellations.add(flightId);
          completed += 1;
        }
      }
      return completed;
    },

    async countLiveOnFlight(flightId, now) {
      return countLive(flightId, now);
    },

    peek(id) {
      const booking = bookings.get(id);
      return booking === undefined ? undefined : read(booking);
    },

    all() {
      return [...bookings.values()].map(read);
    },
  };
}

/**
 * The FlightSearch fake (Day 51): the same answers as the Postgres search,
 * reached another way. Where SQL turns the local dates into one UTC
 * interval, this asks Intl for each flight's local departure date in its
 * origin's zone and compares the date strings. The flight repository
 * contract's twin, tests/contracts/flight-search.contract.ts, holds the two
 * together.
 */
export function createInMemoryFlightSearch(
  store: InMemoryFlightStore,
  airports: readonly Airport[],
): FlightSearch {
  const zoneOf = new Map(airports.map((airport) => [airport.code, airport.timeZone]));

  function localDate(instant: string, timeZone: string): string {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instant));
  }

  function availabilityOf(flight: Omit<Flight, "availableSeats">) {
    return (Object.entries(flight.fares) as Array<[FareClass, Money]>)
      .map(([fareClass, fare]) => ({
        fareClass,
        fare,
        availableSeats: (store.seats.get(flight.id) ?? []).filter(
          (seat) => seat.fareClass === fareClass && seat.status === "AVAILABLE",
        ).length,
      }))
      .sort((a, b) => a.fare.amount - b.fare.amount || (a.fareClass < b.fareClass ? -1 : 1));
  }

  return {
    async findDetails(flightId) {
      const flight = store.flights.get(flightId);
      const originTimeZone = flight === undefined ? undefined : zoneOf.get(flight.origin);
      const destinationTimeZone = flight === undefined ? undefined : zoneOf.get(flight.destination);
      if (flight === undefined || originTimeZone === undefined || destinationTimeZone === undefined) {
        return undefined;
      }
      const availability = availabilityOf(flight);
      return {
        ...structuredClone(flight),
        departureAt: new Date(flight.departureAt).toISOString(),
        arrivalAt: new Date(flight.arrivalAt).toISOString(),
        availableSeats: availability.reduce((total, entry) => total + entry.availableSeats, 0),
        originTimeZone,
        destinationTimeZone,
        availability,
      };
    },

    async search(query, now) {
      const originZone = zoneOf.get(query.origin);
      const destinationZone = zoneOf.get(query.destination);
      if (originZone === undefined || destinationZone === undefined) {
        return { items: [], hasNextPage: false };
      }

      const matches: FlightSearchResult[] = [];
      for (const flight of store.flights.values()) {
        if (flight.origin !== query.origin || flight.destination !== query.destination) continue;
        const date = localDate(flight.departureAt, originZone);
        if (date < query.departureDateFrom || date > query.departureDateTo) continue;
        if (!isBookable(flight.status, flight.departureAt, now)) continue;

        const availability = availabilityOf(flight);
        const roomy = availability.filter((entry) => entry.availableSeats >= query.passengers);
        const [cheapest] = roomy;
        if (cheapest === undefined) continue;

        matches.push({
          id: flight.id,
          flightNumber: flight.flightNumber,
          origin: { code: flight.origin, timeZone: originZone },
          destination: { code: flight.destination, timeZone: destinationZone },
          departureAt: new Date(flight.departureAt).toISOString(),
          arrivalAt: new Date(flight.arrivalAt).toISOString(),
          lowestFare: cheapest.fare,
          availability,
        });
      }

      const keyOf = (result: FlightSearchResult): Array<number | string> =>
        query.sort === "price"
          ? [result.lowestFare.amount, toInstant(result.departureAt), result.id]
          : [toInstant(result.departureAt), result.id];
      const compare = (a: Array<number | string>, b: Array<number | string>): number => {
        for (let index = 0; index < a.length; index += 1) {
          const [x, y] = [a[index]!, b[index]!];
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      };

      const after = query.after;
      const afterKey =
        after === undefined
          ? undefined
          : query.sort === "price"
            ? [after.lowestFare, toInstant(after.departureAt), after.id]
            : [toInstant(after.departureAt), after.id];
      const ordered = matches
        .filter((result) => afterKey === undefined || compare(keyOf(result), afterKey) > 0)
        .sort((a, b) => compare(keyOf(a), keyOf(b)));

      return {
        items: ordered.slice(0, query.limit),
        hasNextPage: ordered.length > query.limit,
      };
    },
  };
}

/**
 * The AdminReports fake (Day 53): the same answers as Postgres, reached
 * another way — local dates through Intl like the FlightSearch fake, counts
 * by walking the seats. tests/contracts/admin-reports.contract.ts holds the
 * two together. One "snapshot" for free: the fake is single-threaded.
 */
export function createInMemoryAdminReports(deps: {
  flights: InMemoryFlightStore;
  bookings: InMemoryBookingRepository;
  audit: InMemoryAuditRecorder;
  airports: readonly Airport[];
}): AdminReports {
  const zoneOf = new Map(deps.airports.map((airport) => [airport.code, airport.timeZone]));

  function localDate(instant: string, timeZone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instant));
  }

  function reportFlight(flight: Omit<Flight, "availableSeats">): ReportFlight {
    return {
      id: flight.id,
      flightNumber: flight.flightNumber,
      origin: flight.origin,
      originTimeZone: zoneOf.get(flight.origin) ?? "UTC",
      destination: flight.destination,
      departureAt: new Date(flight.departureAt).toISOString(),
      status: flight.status,
    };
  }

  function classesOf(flightId: string, now: Date): ClassSeats[] {
    const byClass = new Map<FareClass, { total: number; booked: number; held: number; available: number }>();
    for (const seat of deps.flights.seats.get(flightId) ?? []) {
      const counts = byClass.get(seat.fareClass) ?? { total: 0, booked: 0, held: 0, available: 0 };
      counts.total += 1;
      const holder = seat.bookingId === null ? undefined : deps.bookings.peek(seat.bookingId);
      const holdValid =
        holder?.holdExpiresAt !== null &&
        holder?.holdExpiresAt !== undefined &&
        !isHoldLapsed(holder.holdExpiresAt, now);
      if (seat.status === "BOOKED") counts.booked += 1;
      else if (seat.status === "HELD" && holdValid) counts.held += 1;
      else counts.available += 1;
      byClass.set(seat.fareClass, counts);
    }
    return [...byClass.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([fareClass, counts]) => ({ fareClass, ...counts }));
  }

  const seatOrder = (seat: string | null): [number, string] => {
    const match = seat === null ? null : /^(\d+)([A-Z])$/.exec(seat);
    return match === null ? [Number.MAX_SAFE_INTEGER, ""] : [Number(match[1]), match[2] ?? ""];
  };

  return {
    async findManifest(flightId, now) {
      const flight = deps.flights.flights.get(flightId);
      if (flight === undefined) return undefined;
      const onFlight = deps.bookings.all().filter((booking) => booking.flightId === flightId);
      const passengers = onFlight
        .filter((booking) => booking.status === "CONFIRMED")
        .flatMap((booking) =>
          booking.passengers.map((passenger) => ({
            reference: booking.reference,
            name: passenger.name,
            seat: passenger.seat,
            fareClass: passenger.fareClass,
          })),
        )
        .sort((a, b) => {
          const [rowA, letterA] = seatOrder(a.seat);
          const [rowB, letterB] = seatOrder(b.seat);
          return rowA - rowB || (letterA < letterB ? -1 : letterA > letterB ? 1 : 0) || (a.reference < b.reference ? -1 : 1);
        });
      return {
        flight: reportFlight(flight),
        classes: classesOf(flightId, now),
        heldBookings: onFlight.filter(
          (booking) =>
            booking.status === "HELD" &&
            booking.holdExpiresAt !== null &&
            !isHoldLapsed(booking.holdExpiresAt, now),
        ).length,
        passengers,
      };
    },

    async loadFactor(query, now) {
      const matches = [...deps.flights.flights.values()]
        .filter((flight) => {
          const zone = zoneOf.get(flight.origin);
          if (zone === undefined) return false;
          const date = localDate(flight.departureAt, zone);
          return (
            date >= query.dateFrom &&
            date <= query.dateTo &&
            (query.origin === undefined || flight.origin === query.origin)
          );
        })
        .map((flight) => ({ ...reportFlight(flight), classes: classesOf(flight.id, now) }))
        .filter(
          (flight) =>
            query.after === undefined ||
            toInstant(flight.departureAt) > toInstant(query.after.at) ||
            (toInstant(flight.departureAt) === toInstant(query.after.at) && flight.id > query.after.id),
        )
        .sort((a, b) => toInstant(a.departureAt) - toInstant(b.departureAt) || (a.id < b.id ? -1 : 1));
      return { items: matches.slice(0, query.limit), hasNextPage: matches.length > query.limit };
    },

    async auditLog(query) {
      const entries: AuditLogEntry[] = deps.audit.records
        .filter(
          (record) =>
            (query.target === undefined ||
              (record.target.type === query.target.type && record.target.id === query.target.id)) &&
            (query.range === undefined ||
              (toInstant(record.occurredAt) >= toInstant(query.range.from) &&
                toInstant(record.occurredAt) < toInstant(query.range.to))) &&
            (query.actorType === undefined || record.actor.type === query.actorType) &&
            (query.actorId === undefined || record.actor.id === query.actorId) &&
            (query.action === undefined || record.action === query.action),
        )
        .map((record) => ({
          id: record.id,
          action: record.action,
          actor: { type: record.actor.type, id: record.actor.id },
          target: { type: record.target.type, id: record.target.id },
          requestId: record.requestId ?? null,
          occurredAt: new Date(record.occurredAt).toISOString(),
          metadata: record.metadata,
        }))
        .filter(
          (entry) =>
            query.after === undefined ||
            toInstant(entry.occurredAt) < toInstant(query.after.at) ||
            (toInstant(entry.occurredAt) === toInstant(query.after.at) && entry.id < query.after.id),
        )
        .sort((a, b) => toInstant(b.occurredAt) - toInstant(a.occurredAt) || (a.id < b.id ? 1 : -1));
      return { items: entries.slice(0, query.limit), hasNextPage: entries.length > query.limit };
    },
  };
}

export function createInMemoryAirportRepository(
  initial: readonly Airport[] = [],
): AirportRepository {
  const airports = new Map<string, Airport>(
    initial.map((airport) => [airport.id, structuredClone(airport)]),
  );

  return {
    async create(airport) {
      if ([...airports.values()].some((stored) => stored.code === airport.code)) {
        return { outcome: "duplicate" };
      }

      airports.set(airport.id, structuredClone(airport));
      return { outcome: "created" };
    },

    async findPage({ limit, offset }) {
      const ordered = [...airports.values()].sort((a, b) =>
        a.code.localeCompare(b.code),
      );

      return {
        items: ordered
          .slice(offset, offset + limit)
          .map((airport) => structuredClone(airport)),
        totalItems: ordered.length,
      };
    },

    async findByCode(code) {
      const airport = [...airports.values()].find(
        (stored) => stored.code === code,
      );
      return airport === undefined ? undefined : structuredClone(airport);
    },
  };
}

export function createInMemoryAircraftRepository(
  initial: readonly Aircraft[] = [],
): AircraftRepository {
  const aircraftById = new Map<string, Aircraft>(
    initial.map((aircraft) => [aircraft.id, structuredClone(aircraft)]),
  );

  return {
    async create(aircraft) {
      const registered = [...aircraftById.values()].some(
        (stored) => stored.registration === aircraft.registration,
      );

      if (registered) {
        return { outcome: "duplicate" };
      }

      // Postgres rejects this with PK_seats and stores nothing — a thrown
      // error, not an outcome, because expandSeatLayout already prevents it.
      const positions = aircraft.seats.map((seat) =>
        formatSeatPosition(seat.position),
      );
      if (new Set(positions).size !== positions.length) {
        throw new Error("duplicate seat position in layout");
      }

      aircraftById.set(aircraft.id, structuredClone(aircraft));
      return { outcome: "created" };
    },

    async findById(id) {
      return withSortedSeats(aircraftById.get(id));
    },

    async findByRegistration(registration) {
      return withSortedSeats(
        [...aircraftById.values()].find(
          (stored) => stored.registration === registration,
        ),
      );
    },
  };
}

function withSortedSeats(aircraft: Aircraft | undefined): Aircraft | undefined {
  if (aircraft === undefined) {
    return undefined;
  }

  const seats = [...aircraft.seats].sort(
    (a, b) =>
      a.position.row - b.position.row ||
      a.position.letter.localeCompare(b.position.letter),
  );

  return structuredClone({ ...aircraft, seats });
}

export type InMemoryAuditRecorder = AuditRecorder &
  Readonly<{
    readonly records: readonly AuditRecordInput[];
  }>;

export function createInMemoryAuditRecorder(): InMemoryAuditRecorder {
  const records: AuditRecordInput[] = [];

  return {
    async record(input) {
      records.push(structuredClone(input));
    },
    get records() {
      return structuredClone(records);
    },
  };
}

export type InMemoryOutboxRepository = OutboxRepository &
  Readonly<{
    readonly entries: readonly OutboxEntry[];
  }>;

export function createInMemoryOutboxRepository(): InMemoryOutboxRepository {
  const entries: OutboxEntry[] = [];
  const published = new Set<string>();

  return {
    async enqueue(entry) {
      entries.push(structuredClone(entry));
    },

    async findUnpublished(limit) {
      return entries
        .filter((entry) => !published.has(entry.id))
        .sort((a, b) => toInstant(a.createdAt) - toInstant(b.createdAt))
        .slice(0, limit)
        .map((entry) => structuredClone(entry));
    },

    async markPublished(id) {
      published.add(id);
    },

    get entries() {
      return structuredClone(entries);
    },
  };
}

/**
 * Runs the operation and returns its result — no rollback. Rollback is
 * database semantics, not business logic: it is proven against Postgres in
 * postgres-transaction-runner / create-flight.postgres integration tests.
 * A unit test that needs "nothing was written after a failure" belongs there.
 */
export function createInMemoryTransactionRunner(): TransactionRunner {
  return {
    async run(operation) {
      return await operation();
    },
  };
}

type InMemoryIdempotencyRecord = {
  fingerprint: string;
  createdAt: Date;
  paymentId?: string;
  response?: StoredResponse;
};

export type InMemoryIdempotencyRepository = IdempotencyRepository &
  Readonly<{
    /** Test-only read of the payment a key was attached to. */
    paymentIdOf(scope: IdempotencyScope, key: string): string | undefined;
  }>;

/**
 * Mirrors the Postgres adapter's outcomes. It cannot mirror the wait: a
 * second claim of a key whose first claim is uncommitted blocks on Postgres
 * and gets "in-progress" afterwards; here everything is committed at once.
 * The concurrent case is proven on Postgres (race test A).
 */
export function createInMemoryIdempotencyRepository(): InMemoryIdempotencyRepository {
  const records = new Map<string, InMemoryIdempotencyRecord>();
  const id = (scope: IdempotencyScope, key: string) =>
    JSON.stringify([scope.accountId, scope.operation, key]);

  function claimed(scope: IdempotencyScope, key: string) {
    const record = records.get(id(scope, key));
    if (record === undefined || record.response !== undefined) {
      throw new Error(`Idempotency key ${key} is not in progress`);
    }
    return record;
  }

  return {
    async claim(scope, key, fingerprint, now): Promise<ClaimResult> {
      const record = records.get(id(scope, key));

      if (record === undefined) {
        records.set(id(scope, key), { fingerprint, createdAt: now });
        return { outcome: "claimed" };
      }

      return record.response === undefined
        ? { outcome: "in-progress", fingerprint: record.fingerprint }
        : {
            outcome: "completed",
            fingerprint: record.fingerprint,
            response: structuredClone(record.response),
          };
    },

    async attachPayment(scope, key, paymentId) {
      claimed(scope, key).paymentId = paymentId;
    },

    async complete(scope, key, response) {
      claimed(scope, key).response = structuredClone(response);
    },

    async completeForPayment(paymentId, response) {
      const record = [...records.values()].find(
        (candidate) => candidate.paymentId === paymentId && candidate.response === undefined,
      );
      if (record === undefined) {
        throw new Error(`The idempotency key of payment ${paymentId} is not in progress`);
      }
      record.response = structuredClone(response);
    },

    async release(scope, key) {
      if (records.get(id(scope, key))?.response === undefined) {
        records.delete(id(scope, key));
      }
    },

    async deleteCompletedBefore(cutoff, limit) {
      const expired = [...records.entries()]
        .filter(([, record]) => record.response !== undefined && record.createdAt < cutoff)
        .sort(([, left], [, right]) => left.createdAt.getTime() - right.createdAt.getTime())
        .slice(0, limit);
      for (const [recordId] of expired) {
        records.delete(recordId);
      }
      return expired.length;
    },

    paymentIdOf(scope, key) {
      return records.get(id(scope, key))?.paymentId;
    },
  };
}

/**
 * Mirrors the Postgres adapter, the two partial unique indexes included: a
 * second PROCESSING payment for a booking is payment-in-progress, a second
 * SUCCEEDED one throws (BR-PAY-05, a 23505 on Postgres). Transitions clear
 * the token, reset attempts and set next_attempt_at like the adapter
 * (Day 49C).
 */
export function createInMemoryPaymentRepository(): PaymentRepository {
  const payments = new Map<string, Payment>();

  function transition(
    paymentId: string,
    from: PaymentStatus,
    to: PaymentStatus,
    now: Date,
    set: Partial<Pick<Payment, "providerReference" | "failureReason">> = {},
  ): void {
    const payment = payments.get(paymentId);
    if (payment?.status !== from) {
      throw new Error(`Payment ${paymentId} is not ${from}; cannot move it to ${to}`);
    }
    if (
      to === "SUCCEEDED" &&
      [...payments.values()].some(
        (other) => other.bookingId === payment.bookingId && other.status === "SUCCEEDED",
      )
    ) {
      throw new Error(`Booking ${payment.bookingId} already has a SUCCEEDED payment`);
    }
    payments.set(paymentId, {
      ...payment,
      ...set,
      status: to,
      paymentMethodToken: null,
      attempts: 0,
      nextAttemptAt: to === "REFUND_PENDING" ? now.toISOString() : null,
      updatedAt: now.toISOString(),
    });
  }

  return {
    async start(payment) {
      if (payments.has(payment.id)) {
        throw new Error(`duplicate payment id: ${payment.id}`);
      }
      if (
        [...payments.values()].some(
          (other) => other.bookingId === payment.bookingId && other.status === "PROCESSING",
        )
      ) {
        return { outcome: "payment-in-progress" };
      }

      payments.set(payment.id, {
        ...structuredClone(payment),
        status: "PROCESSING",
        providerReference: null,
        failureReason: null,
        attempts: 0,
        updatedAt: payment.createdAt,
      });
      return { outcome: "started" };
    },

    async markSucceeded(paymentId, providerReference, now) {
      transition(paymentId, "PROCESSING", "SUCCEEDED", now, { providerReference });
    },

    async markFailed(paymentId, reason, now) {
      transition(paymentId, "PROCESSING", "FAILED", now, { failureReason: reason });
    },

    async markRefundPending(paymentId, providerReference, now) {
      transition(paymentId, "PROCESSING", "REFUND_PENDING", now, { providerReference });
    },

    async markRefunded(paymentId, now) {
      transition(paymentId, "REFUND_PENDING", "REFUNDED", now);
    },

    async markRefundFailed(paymentId, reason, now) {
      transition(paymentId, "REFUND_PENDING", "REFUND_FAILED", now, { failureReason: reason });
    },

    async markRefundPendingForCancelledBooking(bookingId, now) {
      const paid = [...payments.values()].find(
        (payment) => payment.bookingId === bookingId && payment.status === "SUCCEEDED",
      );
      if (paid === undefined) {
        return undefined;
      }
      transition(paid.id, "SUCCEEDED", "REFUND_PENDING", now);
      return structuredClone(payments.get(paid.id));
    },

    async claimDue(now, leaseMs, limit) {
      const due = [...payments.values()]
        .filter(
          (payment) =>
            (payment.status === "PROCESSING" || payment.status === "REFUND_PENDING") &&
            payment.nextAttemptAt !== null &&
            payment.nextAttemptAt <= now.toISOString(),
        )
        .sort((left, right) =>
          `${left.nextAttemptAt}${left.id}`.localeCompare(`${right.nextAttemptAt}${right.id}`),
        )
        .slice(0, limit);
      const leasedUntil = new Date(now.getTime() + leaseMs).toISOString();

      return due
        .map((payment) => {
          const claimed = { ...payment, nextAttemptAt: leasedUntil, attempts: payment.attempts + 1 };
          payments.set(payment.id, claimed);
          return structuredClone(claimed);
        })
        .sort((left, right) => left.id.localeCompare(right.id));
    },

    async reschedule(paymentId, status, nextAttemptAt) {
      const payment = payments.get(paymentId);
      if (payment?.status !== status) {
        throw new Error(`Payment ${paymentId} is not ${status}; cannot reschedule it`);
      }
      payments.set(paymentId, { ...payment, nextAttemptAt: nextAttemptAt.toISOString() });
    },

    async findById(paymentId) {
      const payment = payments.get(paymentId);
      return payment === undefined ? undefined : structuredClone(payment);
    },
  };
}

/**
 * A charge the fake should answer: any result the port can return, or
 * `lost-response` — the provider takes the money and the answer never
 * arrives, so the caller sees `unknown` (Day 49C's most dangerous case).
 */
export type FakeChargeScript = ChargeResult | Readonly<{ outcome: "lost-response" }>;

export type FakePaymentGateway = PaymentGateway &
  Readonly<{
    /** Every charge call, in order — tests count them (Day 49B race tests). */
    readonly charges: readonly ChargeRequest[];
    readonly refunds: readonly RefundRequest[];
    /**
     * What the provider really did, not what the caller heard: payment ids
     * whose money was taken, and those given back. Each id appears at most
     * once in each list (Day 49C money invariants).
     */
    readonly ledger: Readonly<{ charged: readonly string[]; refunded: readonly string[] }>;
    /** Queue the next charge results; when empty, a charge succeeds. */
    willCharge(...results: FakeChargeScript[]): void;
    /** Queue the next refund results; when empty, a refund succeeds. */
    willRefund(...results: RefundResult[]): void;
  }>;

/**
 * A scripted gateway for unit and integration tests. It keeps the provider's
 * idempotency the port promises (Day 49C): once a payment id has a definite
 * result, charging it again answers that result without taking a script, and
 * a refunded id answers `refunded` again. An `unknown` script leaves nothing
 * behind, so the next charge of that id takes the next script. Every call is
 * still recorded, so a test that charges twice sees two calls.
 *
 * `onCharge` / `onRefund` run inside the call, before the result is returned —
 * a test moves its clock past the hold deadline there, or awaits a gate to
 * hold the payment between phases.
 */
export function createFakePaymentGateway(
  options: {
    onCharge?: (request: ChargeRequest) => void | Promise<void>;
    onRefund?: (request: RefundRequest) => void | Promise<void>;
  } = {},
): FakePaymentGateway {
  const charges: ChargeRequest[] = [];
  const refunds: RefundRequest[] = [];
  const chargeScripts: FakeChargeScript[] = [];
  const refundResults: RefundResult[] = [];
  const definiteCharges = new Map<string, ChargeResult>();
  const charged: string[] = [];
  const refunded: string[] = [];

  return {
    async charge(request) {
      charges.push(structuredClone(request));
      await options.onCharge?.(request);

      const previous = definiteCharges.get(request.paymentId);
      if (previous !== undefined) {
        return previous;
      }

      const script = chargeScripts.shift() ?? {
        outcome: "succeeded",
        providerReference: `fake_ch_${request.paymentId}`,
      };

      if (script.outcome === "unknown") {
        return script;
      }

      const result: ChargeResult =
        script.outcome === "lost-response"
          ? { outcome: "succeeded", providerReference: `fake_ch_${request.paymentId}` }
          : script;
      definiteCharges.set(request.paymentId, result);
      if (result.outcome === "succeeded") {
        charged.push(request.paymentId);
      }

      return script.outcome === "lost-response"
        ? { outcome: "unknown", reason: "timeout" }
        : result;
    },

    async refund(request) {
      refunds.push(structuredClone(request));
      await options.onRefund?.(request);

      if (refunded.includes(request.paymentId)) {
        return { outcome: "refunded" };
      }

      const result = refundResults.shift() ?? { outcome: "refunded" };
      if (result.outcome === "refunded") {
        refunded.push(request.paymentId);
      }
      return result;
    },

    willCharge(...results) {
      chargeScripts.push(...results);
    },

    willRefund(...results) {
      refundResults.push(...results);
    },

    get charges() {
      return structuredClone(charges);
    },

    get refunds() {
      return structuredClone(refunds);
    },

    get ledger() {
      return { charged: [...charged], refunded: [...refunded] };
    },
  };
}

export function createInMemoryHealthChecks(
  status: HealthStatus = "ok",
): HealthChecks {
  return {
    async checkReadiness() {
      return { status, checks: { database: { status } } };
    },
  };
}

/**
 * For HTTP tests that build createApp() but never open or cancel a flight.
 * Both are tested in flights.api.test.ts with the real use cases.
 */
export function createUnusedOpenFlight(): {
  openFlight: OpenFlight;
  cancelFlight: CancelFlight;
} {
  return {
    openFlight: async () => ({ outcome: "not-found" }),
    cancelFlight: async () => ({ outcome: "not-found" }),
  };
}

/**
 * For HTTP tests that build createApp() but never read a seat map. The seat
 * map is tested in flights.api.test.ts with the real use case.
 */
export function createUnusedFlightSeatMap(): { getFlightSeatMap: GetFlightSeatMap } {
  return { getFlightSeatMap: async () => ({ outcome: "not-found" }) };
}

/**
 * For HTTP tests that build createApp() but never exercise the airport and
 * aircraft routes. Reference data itself is tested in
 * reference-data.api.test.ts with the real use cases.
 */
export function createUnusedReferenceData(): {
  registerAirport: RegisterAirport;
  listAirports: ListAirports;
  registerAircraft: RegisterAircraft;
} {
  return {
    registerAirport: async () => ({ outcome: "duplicate" }),
    listAirports: async () => ({
      outcome: "success",
      items: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    }),
    registerAircraft: async () => ({ outcome: "duplicate" }),
  };
}

/**
 * For HTTP tests that build createApp() but never read an admin report.
 * The reports are tested in admin-reports.api.test.ts with the real use cases.
 */
export function createUnusedAdminReports(): {
  getFlightManifest: GetFlightManifest;
  getLoadFactor: GetLoadFactor;
  queryAuditLog: QueryAuditLog;
} {
  const empty = { outcome: "success" as const, items: [], page: { hasNextPage: false, nextCursor: null } };
  return {
    getFlightManifest: async () => ({ outcome: "not-found" }),
    getLoadFactor: async () => empty,
    queryAuditLog: async () => empty,
  };
}

/**
 * For HTTP tests that build createApp() but never pay for a booking. Payment
 * itself is tested in bookings.api.test.ts with the real use case.
 */
export function createUnusedPayForBooking(): { payForBooking: PayForBooking } {
  return { payForBooking: async () => ({ outcome: "payment-in-progress" }) };
}

/**
 * For HTTP tests that build createApp() but never exercise the booking read
 * routes (health, observability, JWT, flights). Booking behavior itself is
 * tested in bookings.api.test.ts with the real use cases.
 */
export function createUnusedBookingReads(): {
  getBooking: GetBooking;
  getBookingByReference: GetBookingByReference;
  listBookings: ListBookings;
} {
  return {
    getBooking: async () => ({ outcome: "not-found" }),
    getBookingByReference: async () => ({ outcome: "not-found" }),
    listBookings: async () => ({
      outcome: "success",
      items: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    }),
  };
}
