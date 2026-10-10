import type {
  Aircraft,
  AircraftRepository,
} from "../../src/aircraft/aircraft-repository.js";
import type { RegisterAircraft } from "../../src/aircraft/register-aircraft.js";
import { formatSeatPosition } from "../../src/aircraft/seat-position.js";
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
import type { GetBooking } from "../../src/bookings/get-booking.js";
import type { ListBookings } from "../../src/bookings/list-bookings.js";
import {
  AIRCRAFT_TURNAROUND_MS,
  isBookable,
} from "../../src/flights/flight-lifecycle.js";
import type { FlightRepository } from "../../src/flights/flight-repository.js";
import type { OpenFlight } from "../../src/flights/open-flight.js";
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
      const occupies = (candidate: Flight) => ({
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

      flights.set(flight.id, {
        ...structuredClone(flight),
        departureAt: new Date(flight.departureAt).toISOString(),
        arrivalAt: new Date(flight.arrivalAt).toISOString(),
      });
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
  const { flights } = deps;
  const bookings = new Map<string, Booking>();

  return {
    async reserveSeat(flightId, now) {
      const flight = flights.get(flightId);

      if (flight === undefined) {
        return { outcome: "flight-not-found" };
      }
      if (!isBookable(flight.status, flight.departureAt, now)) {
        return { outcome: "sales-closed" };
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
