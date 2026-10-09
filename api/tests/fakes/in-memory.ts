import type {
  AuditRecorder,
  AuditRecordInput,
} from "../../src/audit/audit-recorder.js";
import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
} from "../../src/bookings/booking-repository.js";
import type { GetBooking } from "../../src/bookings/get-booking.js";
import type { ListBookings } from "../../src/bookings/list-bookings.js";
import type { FlightRepository } from "../../src/flights/flight-repository.js";
import type {
  HealthChecks,
  HealthStatus,
} from "../../src/health/health-checks.js";
import type {
  OutboxEntry,
  OutboxRepository,
} from "../../src/outbox/outbox-repository.js";
import type { TransactionRunner } from "../../src/transactions/transaction-runner.js";
import type { Flight } from "../../src/types.js";

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

/** Shared between the flight and booking fakes: bookings change seat counts. */
export type InMemoryFlightStore = Map<string, Flight>;

export function createInMemoryFlightStore(): InMemoryFlightStore {
  return new Map();
}

function toInstant(isoDate: string): number {
  return new Date(isoDate).getTime();
}

export function createInMemoryFlightRepository(
  flights: InMemoryFlightStore = createInMemoryFlightStore(),
): FlightRepository {
  return {
    async findPage({ limit, offset }) {
      const ordered = [...flights.values()].sort(
        (a, b) =>
          toInstant(a.departureAt) - toInstant(b.departureAt) ||
          a.id.localeCompare(b.id),
      );

      return {
        items: ordered.slice(offset, offset + limit).map((flight) =>
          structuredClone(flight),
        ),
        totalItems: flights.size,
      };
    },

    async findById(id) {
      const flight = flights.get(id);
      return flight === undefined ? undefined : structuredClone(flight);
    },

    async create(flight) {
      // Mirrors Postgres: PK on id, UNIQUE on (flight_number, departure_at)
      // compared as instants (TIMESTAMPTZ), not as strings.
      const isDuplicate =
        flights.has(flight.id) ||
        [...flights.values()].some(
          (existing) =>
            existing.flightNumber === flight.flightNumber &&
            toInstant(existing.departureAt) === toInstant(flight.departureAt),
        );

      if (isDuplicate) {
        return { outcome: "duplicate" };
      }

      flights.set(flight.id, {
        ...structuredClone(flight),
        departureAt: new Date(flight.departureAt).toISOString(),
        arrivalAt: new Date(flight.arrivalAt).toISOString(),
      });
      return { outcome: "created" };
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
  const { flights } = deps;
  const bookings = new Map<string, Booking>();

  return {
    async reserveSeat(flightId) {
      const flight = flights.get(flightId);

      if (flight === undefined) {
        return { outcome: "flight-not-found" };
      }
      if (flight.availableSeats <= 0) {
        return { outcome: "sold-out" };
      }

      flight.availableSeats -= 1;
      return { outcome: "reserved" };
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

      bookings.set(booking.id, structuredClone(booking));
    },

    async findById(bookingId, scope) {
      const booking = bookings.get(bookingId);
      return booking === undefined || !isInScope(booking, scope)
        ? undefined
        : structuredClone(booking);
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
          .map((booking) => structuredClone(booking)),
        totalItems: visible.length,
      };
    },

    async cancel(bookingId, scope) {
      const booking = bookings.get(bookingId);

      // Out of scope is not-found, never already-cancelled (BR-AUTH-02).
      if (booking === undefined || !isInScope(booking, scope)) {
        return { outcome: "not-found" };
      }
      if (booking.status === "cancelled") {
        return { outcome: "already-cancelled" };
      }

      bookings.set(bookingId, { ...booking, status: "cancelled" });
      return { outcome: "cancelled", flightId: booking.flightId };
    },

    async releaseSeat(flightId) {
      // Unknown flight: Postgres's UPDATE matches zero rows, silently.
      const flight = flights.get(flightId);
      if (flight !== undefined) {
        flight.availableSeats += 1;
      }
    },

    peek(id) {
      const booking = bookings.get(id);
      return booking === undefined ? undefined : structuredClone(booking);
    },
  };
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
 * For HTTP tests that build createApp() but never exercise the booking read
 * routes (health, observability, JWT, flights). Booking behavior itself is
 * tested in bookings.api.test.ts with the real use cases.
 */
export function createUnusedBookingReads(): {
  getBooking: GetBooking;
  listBookings: ListBookings;
} {
  return {
    getBooking: async () => ({ outcome: "not-found" }),
    listBookings: async () => ({
      outcome: "success",
      items: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    }),
  };
}
