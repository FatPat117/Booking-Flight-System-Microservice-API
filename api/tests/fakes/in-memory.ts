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
import type { GetFlightSeatMap } from "../../src/flights/get-flight-seat-map.js";
import type { OpenFlight } from "../../src/flights/open-flight.js";
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
  }>;

function isInScope(booking: Booking, scope: BookingAccessScope): boolean {
  return scope.kind === "admin" || booking.ownerAccountId === scope.accountId;
}

export function createInMemoryBookingRepository(deps: {
  flights: InMemoryFlightStore;
}): InMemoryBookingRepository {
  const { flights, seats } = deps.flights;
  const bookings = new Map<string, Booking>();

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
        picked = flightSeats
          .filter((seat) => seat.status === "AVAILABLE")
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

    async cancel(bookingId, scope, now) {
      const booking = bookings.get(bookingId);

      // Out of scope is not-found, never already-cancelled (BR-AUTH-02).
      if (booking === undefined || !isInScope(booking, scope)) {
        return { outcome: "not-found" };
      }
      // Same condition as the Postgres UPDATE: CONFIRMED, or HELD still
      // valid at `now` (BR-BOOK-10).
      const cancellable =
        booking.status === "CONFIRMED" ||
        (booking.status === "HELD" &&
          booking.holdExpiresAt !== null &&
          !isHoldLapsed(booking.holdExpiresAt, now));
      if (!cancellable) {
        return classifyNotCancelled(booking.status, booking.holdExpiresAt, now);
      }

      bookings.set(bookingId, { ...booking, status: "CANCELLED" });
      for (const seat of seats.get(booking.flightId) ?? []) {
        if (seat.bookingId === bookingId) {
          seat.status = "AVAILABLE";
          seat.bookingId = null;
        }
      }
      return { outcome: "cancelled", flightId: booking.flightId };
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
    // at `now` (BR-BOOK-10).
    async confirmHold(bookingId, scope, now) {
      const booking = bookings.get(bookingId);

      if (
        booking === undefined ||
        !isInScope(booking, scope) ||
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

    peek(id) {
      const booking = bookings.get(id);
      return booking === undefined ? undefined : read(booking);
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
 * For HTTP tests that build createApp() but never open a flight. Opening is
 * tested in flights.api.test.ts with the real use case.
 */
export function createUnusedOpenFlight(): { openFlight: OpenFlight } {
  return { openFlight: async () => ({ outcome: "not-found" }) };
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
