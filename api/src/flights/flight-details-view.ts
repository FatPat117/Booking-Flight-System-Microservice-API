import type { FareAvailability, FlightDetails } from "./flight-search.js";
import { toFlightView, type FlightView } from "./flight-view.js";
import { arrivalDayOffset, toLocalIso } from "./local-time.js";

/** Local wall-clock times of a flight, each in its own airport's zone (Decision 17). */
export type LocalTimes = Readonly<{
  departureLocal: string;
  arrivalLocal: string;
  arrivalDayOffset: number;
}>;

export function localTimesOf(
  departureAt: string,
  originTimeZone: string,
  arrivalAt: string,
  destinationTimeZone: string,
): LocalTimes {
  return {
    departureLocal: toLocalIso(departureAt, originTimeZone),
    arrivalLocal: toLocalIso(arrivalAt, destinationTimeZone),
    arrivalDayOffset: arrivalDayOffset(departureAt, originTimeZone, arrivalAt, destinationTimeZone),
  };
}

/**
 * GET /api/flights/:id (US-FLT-05): the flight view as before, plus its
 * availability per fare class and local times. The zone names stay
 * inside: the offsets in the local times already say them.
 */
export type FlightDetailsView = FlightView &
  LocalTimes &
  Readonly<{ availability: readonly FareAvailability[] }>;

export function toFlightDetailsView(details: FlightDetails, now: Date): FlightDetailsView {
  const { originTimeZone, destinationTimeZone, availability, ...flight } = details;
  return {
    ...toFlightView(flight, now),
    ...localTimesOf(flight.departureAt, originTimeZone, flight.arrivalAt, destinationTimeZone),
    availability,
  };
}
