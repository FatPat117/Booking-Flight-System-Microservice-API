import type { DatabaseSync } from "node:sqlite";

import type { Flight } from "../types.js";
import type {
  CreateFlightRepositoryResult,
  FlightRepository,
} from "./flight-repository.js";

type FlightRow = {
  id: string;
  flight_number: string;
  origin: string;
  destination: string;
  departure_at: string;
  arrival_at: string;
  price_in_cents: number;
  currency: string;
  available_seats: number;
};

function mapFlightRow(row: FlightRow): Flight {
  return {
    id: row.id,
    flightNumber: row.flight_number,
    origin: row.origin,
    destination: row.destination,
    departureAt: row.departure_at,
    arrivalAt: row.arrival_at,
    priceInCents: row.price_in_cents,
    currency: row.currency,
    availableSeats: row.available_seats,
  };
}

export function createSqliteFlightRepository(
  database: DatabaseSync,
): FlightRepository {
  const selectAllFlights = database.prepare(`
    SELECT
      id,
      flight_number,
      origin,
      destination,
      departure_at,
      arrival_at,
      price_in_cents,
      currency,
      available_seats
    FROM flights
    ORDER BY departure_at ASC, id ASC
  `);

  const selectFlightById = database.prepare(`
    SELECT
      id,
      flight_number,
      origin,
      destination,
      departure_at,
      arrival_at,
      price_in_cents,
      currency,
      available_seats
    FROM flights
    WHERE id = ?
  `);

  const insertFlight = database.prepare(`
    INSERT INTO flights (
      id,
      flight_number,
      origin,
      destination,
      departure_at,
      arrival_at,
      price_in_cents,
      currency,
      available_seats
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (flight_number, departure_at) DO NOTHING
  `);

  return {
    findAll(): Flight[] {
      const rows = selectAllFlights.all() as FlightRow[];
      return rows.map(mapFlightRow);
    },

    findById(id: string): Flight | undefined {
      const row = selectFlightById.get(id) as FlightRow | undefined;
      return row ? mapFlightRow(row) : undefined;
    },

    create(flight: Flight): CreateFlightRepositoryResult {
      const result = insertFlight.run(
        flight.id,
        flight.flightNumber,
        flight.origin,
        flight.destination,
        flight.departureAt,
        flight.arrivalAt,
        flight.priceInCents,
        flight.currency,
        flight.availableSeats,
      );

      if (result.changes === 0 || result.changes === 0n) {
        return { outcome: "duplicate" };
      }

      return { outcome: "created" };
    },
  };
}
