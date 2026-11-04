import type { FareClass } from "../aircraft/seat-layout.js";
import type { Money } from "../money/money.js";
import type { Flight } from "../types.js";

export type FlightSearchSort = "departure" | "price";

/**
 * Where the previous page ended: the last item's sort key. `lowestFare` is
 * part of the key only for `sort = price` (Decision 17).
 */
export type FlightSearchKey = Readonly<{
  departureAt: string;
  id: string;
  lowestFare: number;
}>;

/**
 * A validated search (BR-FLT-10): airport codes, the origin's local dates
 * (`YYYY-MM-DD`, inclusive), 1–9 passengers, a page size, and optionally
 * the key to continue after.
 */
export type FlightSearchQuery = Readonly<{
  origin: string;
  destination: string;
  departureDateFrom: string;
  departureDateTo: string;
  passengers: number;
  sort: FlightSearchSort;
  limit: number;
  after?: FlightSearchKey;
}>;

export type FareAvailability = Readonly<{
  fareClass: FareClass;
  availableSeats: number;
  fare: Money;
}>;

export type SearchedAirport = Readonly<{ code: string; timeZone: string }>;

/**
 * One flight as the search screen needs it — not the Flight aggregate.
 * `availability` lists every fare class of the flight, cheapest first;
 * `lowestFare` is the cheapest class with room for all the passengers.
 */
export type FlightSearchResult = Readonly<{
  id: string;
  flightNumber: string;
  origin: SearchedAirport;
  destination: SearchedAirport;
  departureAt: string;
  arrivalAt: string;
  lowestFare: Money;
  availability: readonly FareAvailability[];
}>;

export type FlightSearchPage = Readonly<{
  items: readonly FlightSearchResult[];
  hasNextPage: boolean;
}>;

/**
 * One flight for its details page (US-FLT-05): the stored flight, the zone
 * of each airport, and every fare class with its free seats and fare,
 * cheapest first — what the seat map would count, read in one statement.
 */
export type FlightDetails = Flight &
  Readonly<{
    originTimeZone: string;
    destinationTimeZone: string;
    availability: readonly FareAvailability[];
  }>;

/**
 * The read side of flights for the search screen (Decision 17): a port of
 * its own because it returns a shape of its own, read in one statement per
 * page. A result is a snapshot, not a promise — the hold decides under its
 * locks.
 *
 * Must not know about: Express, HTTP status, cursors as strings (the use
 * case encodes them), SQL or TypeORM types. An unknown airport code simply
 * matches no flight.
 */
export interface FlightSearch {
  search(query: FlightSearchQuery, now: Date): Promise<FlightSearchPage>;
  /** `undefined` when no flight has this id. */
  findDetails(flightId: string): Promise<FlightDetails | undefined>;
}
