import type { Flight } from "../types.js";
import { effectiveFlightStatus, type FlightStatus } from "./flight-lifecycle.js";

/**
 * A flight as readers see it: `status` is the effective one (ADR-008), so a
 * flight stored OPEN reads CLOSED from 1 hour before departure without
 * anything writing to it. Every use case that hands a flight to a caller
 * returns this; the stored Flight stays inside writes and events.
 */
export type FlightView = Omit<Flight, "status"> & { status: FlightStatus };

export function toFlightView(flight: Flight, now: Date): FlightView {
  return {
    ...flight,
    status: effectiveFlightStatus(flight.status, flight.departureAt, now),
  };
}
