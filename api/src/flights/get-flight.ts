import { isUuid } from "../types.js";
import { toFlightDetailsView, type FlightDetailsView } from "./flight-details-view.js";
import type { FlightSearch } from "./flight-search.js";

export type GetFlightResult =
  | { outcome: "found"; flight: FlightDetailsView }
  | { outcome: "not-found" };

/**
 * A malformed id is not-found: it cannot identify a flight, and sent to
 * Postgres it would fail with 22P02 → 500 (Day 44 limitation, closed Day 45).
 * Same shape as getBooking; no shared middleware yet — each resource has its
 * own 404 code and only three routes take an id.
 */
export type GetFlight = (flightId: string) => Promise<GetFlightResult>;

/**
 * Day 51: read through the FlightSearch read port — one statement for the
 * flight, both zones and every class's free seats (US-FLT-05).
 */
export function createGetFlight(dependencies: {
  flightSearch: FlightSearch;
  getCurrentTime: () => Date;
}): GetFlight {
  const { flightSearch, getCurrentTime } = dependencies;

  return async (flightId) => {
    if (!isUuid(flightId)) {
      return { outcome: "not-found" };
    }

    const details = await flightSearch.findDetails(flightId);

    return details === undefined
      ? { outcome: "not-found" }
      : { outcome: "found", flight: toFlightDetailsView(details, getCurrentTime()) };
  };
}
