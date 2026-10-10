import { isUuid } from "../types.js";
import type { FlightRepository } from "./flight-repository.js";
import { toFlightView, type FlightView } from "./flight-view.js";

export type GetFlightResult =
  | { outcome: "found"; flight: FlightView }
  | { outcome: "not-found" };

/**
 * A malformed id is not-found: it cannot identify a flight, and sent to
 * Postgres it would fail with 22P02 → 500 (Day 44 limitation, closed Day 45).
 * Same shape as getBooking; no shared middleware yet — each resource has its
 * own 404 code and only three routes take an id.
 */
export type GetFlight = (flightId: string) => Promise<GetFlightResult>;

export function createGetFlight(dependencies: {
  flightRepository: FlightRepository;
  getCurrentTime: () => Date;
}): GetFlight {
  const { flightRepository, getCurrentTime } = dependencies;

  return async (flightId) => {
    if (!isUuid(flightId)) {
      return { outcome: "not-found" };
    }

    const flight = await flightRepository.findById(flightId);

    return flight === undefined
      ? { outcome: "not-found" }
      : { outcome: "found", flight: toFlightView(flight, getCurrentTime()) };
  };
}
