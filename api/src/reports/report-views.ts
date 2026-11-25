import { effectiveFlightStatus, type FlightStatus } from "../flights/flight-lifecycle.js";
import { toLocalIso } from "../flights/local-time.js";
import type { ClassSeats, ReportFlight } from "./admin-reports.js";

/** A flight as a report shows it: effective status, local departure, no zone name. */
export type ReportFlightView = Readonly<{
  id: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  departureLocal: string;
  status: FlightStatus;
}>;

export function toReportFlightView(flight: ReportFlight, now: Date): ReportFlightView {
  return {
    id: flight.id,
    flightNumber: flight.flightNumber,
    origin: flight.origin,
    destination: flight.destination,
    departureAt: flight.departureAt,
    departureLocal: toLocalIso(flight.departureAt, flight.originTimeZone),
    status: effectiveFlightStatus(flight.status, flight.departureAt, now),
  };
}

/** `sold` is the glossary's word for BOOKED seats; `loadFactor = sold ÷ total`, 4 decimals. */
export type LoadFactorClassView = Readonly<{
  fareClass: ClassSeats["fareClass"];
  total: number;
  sold: number;
  held: number;
  available: number;
  loadFactor: number;
}>;

export function loadFactorOf(sold: number, total: number): number {
  return total === 0 ? 0 : Math.round((sold / total) * 10_000) / 10_000;
}

export function toLoadFactorClassView(seats: ClassSeats): LoadFactorClassView {
  return {
    fareClass: seats.fareClass,
    total: seats.total,
    sold: seats.booked,
    held: seats.held,
    available: seats.available,
    loadFactor: loadFactorOf(seats.booked, seats.total),
  };
}
