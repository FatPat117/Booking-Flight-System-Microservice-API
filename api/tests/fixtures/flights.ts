import type { Aircraft } from "../../src/aircraft/aircraft-repository.js";
import { countSeatsByFareClass, type LayoutSeat } from "../../src/aircraft/seat-layout.js";
import type { Airport } from "../../src/airports/airport-repository.js";
import { vnd } from "../../src/money/money.js";
import type { Flight, FlightFares } from "../../src/types.js";

/**
 * Shared Flight fixtures (Day 46). Since flights reference airports and an
 * aircraft, and an aircraft may not fly two overlapping flights, every test
 * that stores flights needs consistent references and non-overlapping
 * times. One place gets that right instead of twenty local copies.
 *
 * The ids are fixed so the integration tier can insert matching rows
 * (tests/integration/flight-references.ts). The codes ZZA/ZZB are fictional
 * so they never collide with real airports seeded in a dev database.
 */
export const FIXTURE_ORIGIN = Object.freeze({
  id: "a1a1a1a1-0000-4000-8000-000000000001",
  code: "ZZA",
});

export const FIXTURE_DESTINATION = Object.freeze({
  id: "a1a1a1a1-0000-4000-8000-000000000002",
  code: "ZZB",
});

export const FIXTURE_AIRCRAFT_ID = "c1c1c1c1-0000-4000-8000-000000000001";
export const FIXTURE_OTHER_AIRCRAFT_ID = "c1c1c1c1-0000-4000-8000-000000000002";
export const FIXTURE_TWO_CLASS_AIRCRAFT_ID = "c1c1c1c1-0000-4000-8000-000000000003";

/**
 * `count` seats in rows of 6 (ABCDEF). The first `businessRows` rows are
 * BUSINESS, the rest ECONOMY — the default is an economy-only layout.
 */
export function makeSeats(count: number, businessRows = 0): LayoutSeat[] {
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / 6) + 1;
    return {
      position: { row, letter: "ABCDEF"[index % 6] as string },
      fareClass: row <= businessRows ? "BUSINESS" : "ECONOMY",
    };
  });
}

/** What makeFlight prices each class at when the test does not say. */
export const FIXTURE_FARES = Object.freeze({
  ECONOMY: vnd(1_500_000),
  BUSINESS: vnd(4_200_000),
});

/** FIXTURE_FARES for exactly the classes `seats` has (BR-FLT-09). */
export function faresFor(seats: readonly LayoutSeat[]): FlightFares {
  const counts = countSeatsByFareClass(seats);
  return {
    ...(counts.ECONOMY > 0 ? { ECONOMY: FIXTURE_FARES.ECONOMY } : {}),
    ...(counts.BUSINESS > 0 ? { BUSINESS: FIXTURE_FARES.BUSINESS } : {}),
  };
}

function makeAirport(id: string, code: string, city: string): Airport {
  return {
    id,
    code,
    name: `${city} International`,
    city,
    timeZone: "Asia/Ho_Chi_Minh",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Reference data for unit/HTTP tests that create flights through
 * CreateFlight: pass to createInMemoryAirportRepository /
 * createInMemoryAircraftRepository. VN-A321 has 120 seats, VN-A322 has 5,
 * both economy only. VN-A350 has two classes: rows 1–2 BUSINESS (1A–2F),
 * rows 3–5 ECONOMY (3A–5F).
 */
export const TEST_AIRPORTS: readonly Airport[] = [
  makeAirport(FIXTURE_ORIGIN.id, FIXTURE_ORIGIN.code, "Fixture Origin"),
  makeAirport(FIXTURE_DESTINATION.id, FIXTURE_DESTINATION.code, "Fixture Destination"),
  makeAirport("a1a1a1a1-0000-4000-8000-000000000011", "SGN", "Ho Chi Minh City"),
  makeAirport("a1a1a1a1-0000-4000-8000-000000000012", "HAN", "Hanoi"),
  makeAirport("a1a1a1a1-0000-4000-8000-000000000013", "DAD", "Da Nang"),
];

export const TEST_AIRCRAFT: readonly Aircraft[] = [
  {
    id: FIXTURE_AIRCRAFT_ID,
    registration: "VN-A321",
    model: "Airbus A321",
    createdAt: "2026-01-01T00:00:00.000Z",
    seats: makeSeats(120),
  },
  {
    id: FIXTURE_OTHER_AIRCRAFT_ID,
    registration: "VN-A322",
    model: "Airbus A321",
    createdAt: "2026-01-01T00:00:00.000Z",
    seats: makeSeats(5),
  },
  {
    id: FIXTURE_TWO_CLASS_AIRCRAFT_ID,
    registration: "VN-A350",
    model: "Airbus A350",
    createdAt: "2026-01-01T00:00:00.000Z",
    seats: makeSeats(30, 2),
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_DEPARTURE_MS = Date.UTC(2027, 0, 1, 1, 0, 0);
let sequence = 0;

/**
 * An OPEN flight, far enough in the future to be bookable, departing one
 * day after the previous fixture so fixtures never clash on the shared
 * aircraft. Override departureAt and arrivalAt together.
 *
 * `availableSeats` defaults to the aircraft's seat count — what a freshly
 * created flight reads back with (Day 47) — and `fares` to FIXTURE_FARES for
 * the classes the aircraft has (Day 49A).
 */
export function makeFlight(overrides: Partial<Flight> = {}): Flight {
  sequence += 1;
  const departure = FIRST_DEPARTURE_MS + sequence * DAY_MS;
  const aircraftId = overrides.aircraftId ?? FIXTURE_AIRCRAFT_ID;
  const seats =
    TEST_AIRCRAFT.find((aircraft) => aircraft.id === aircraftId)?.seats ?? [];

  return {
    id: crypto.randomUUID(),
    flightNumber: `FX${String(sequence).padStart(4, "0")}`,
    originAirportId: FIXTURE_ORIGIN.id,
    origin: FIXTURE_ORIGIN.code,
    destinationAirportId: FIXTURE_DESTINATION.id,
    destination: FIXTURE_DESTINATION.code,
    aircraftId,
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + 2 * 60 * 60 * 1000).toISOString(),
    fares: faresFor(seats),
    availableSeats: seats.length,
    status: "OPEN",
    ...overrides,
  };
}
