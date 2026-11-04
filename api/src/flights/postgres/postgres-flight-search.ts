import type { DataSource } from "typeorm";

import type { FareClass } from "../../aircraft/seat-layout.js";
import { parseVndFromDatabase, type Money } from "../../money/money.js";
import { resolveEntityManager } from "../../postgres/transaction-context.js";
import { toStoredFlightStatus } from "../flight-lifecycle.js";
import type { FareAvailability, FlightDetails, FlightSearch, FlightSearchResult } from "../flight-search.js";
import { flightSearchSql } from "./flight-search-sql.js";

/**
 * One flight with its zones and per-class availability, one statement
 * (US-FLT-05). Classes come from the flight's fares — exactly its classes,
 * BR-FLT-09 — each with its AVAILABLE seats counted; a sold-out class is 0.
 */
const FLIGHT_DETAILS_SQL = `SELECT flight."id", flight."flight_number", flight."departure_at", flight."arrival_at",
         flight."origin_airport_id", origin."code" AS "origin_code", origin."time_zone" AS "origin_time_zone",
         flight."destination_airport_id", destination."code" AS "destination_code",
         destination."time_zone" AS "destination_time_zone",
         flight."aircraft_id", flight."status",
         coalesce((
           SELECT json_agg(json_build_object(
                    'fareClass', fare."fare_class",
                    'amountVnd', fare."amount_vnd"::text,
                    'availableSeats', (SELECT count(*)::int FROM "flight_seats" seat
                                       WHERE seat."flight_id" = fare."flight_id"
                                         AND seat."fare_class" = fare."fare_class"
                                         AND seat."status" = 'AVAILABLE')
                  ) ORDER BY fare."amount_vnd", fare."fare_class")
           FROM "flight_fares" fare WHERE fare."flight_id" = flight."id"
         ), '[]') AS "classes"
  FROM "flights" flight
  JOIN "airports" origin ON origin."id" = flight."origin_airport_id"
  JOIN "airports" destination ON destination."id" = flight."destination_airport_id"
  WHERE flight."id" = $1`;

type ClassRow = { fareClass: string; availableSeats: number; amountVnd: string };

function mapClasses(classes: readonly ClassRow[]): FareAvailability[] {
  return classes.map((entry) => ({
    // CHK_flight_fares_fare_class guarantees the value set.
    fareClass: entry.fareClass as FareClass,
    availableSeats: entry.availableSeats,
    fare: parseVndFromDatabase(entry.amountVnd),
  }));
}

type SearchRow = {
  id: string;
  flight_number: string;
  departure_at: Date;
  arrival_at: Date;
  origin_code: string;
  origin_time_zone: string;
  destination_code: string;
  destination_time_zone: string;
  lowest_fare: string;
  classes: ClassRow[];
};

function mapResult(row: SearchRow): FlightSearchResult {
  return {
    id: row.id,
    flightNumber: row.flight_number,
    origin: { code: row.origin_code, timeZone: row.origin_time_zone },
    destination: { code: row.destination_code, timeZone: row.destination_time_zone },
    departureAt: row.departure_at.toISOString(),
    arrivalAt: row.arrival_at.toISOString(),
    lowestFare: parseVndFromDatabase(row.lowest_fare),
    availability: mapClasses(row.classes),
  };
}

/**
 * One statement per page (flightSearchSql): it fetches `limit + 1` rows;
 * the extra one only says that a next page exists (Decision 17).
 */
export function createPostgresFlightSearch(dataSource: DataSource): FlightSearch {
  return {
    async search(query, now) {
      const manager = resolveEntityManager(dataSource);
      const parameters: unknown[] = [
        query.origin,
        query.destination,
        query.departureDateFrom,
        query.departureDateTo,
        now,
        query.passengers,
        query.limit + 1,
      ];
      if (query.after !== undefined) {
        parameters.push(query.after.departureAt, query.after.id);
        if (query.sort === "price") {
          parameters.push(query.after.lowestFare);
        }
      }

      const rows = (await manager.query(
        flightSearchSql(query.sort, query.after !== undefined),
        parameters,
      )) as SearchRow[];

      return {
        items: rows.slice(0, query.limit).map(mapResult),
        hasNextPage: rows.length > query.limit,
      };
    },

    async findDetails(flightId) {
      const manager = resolveEntityManager(dataSource);
      const [row] = (await manager.query(FLIGHT_DETAILS_SQL, [flightId])) as Array<{
        id: string;
        flight_number: string;
        departure_at: Date;
        arrival_at: Date;
        origin_airport_id: string;
        origin_code: string;
        origin_time_zone: string;
        destination_airport_id: string;
        destination_code: string;
        destination_time_zone: string;
        aircraft_id: string;
        status: string;
        classes: ClassRow[];
      }>;
      if (row === undefined) {
        return undefined;
      }

      const availability = mapClasses(row.classes);
      const fares: Partial<Record<FareClass, Money>> = {};
      for (const entry of availability) {
        fares[entry.fareClass] = entry.fare;
      }
      const details: FlightDetails = {
        id: row.id,
        flightNumber: row.flight_number,
        originAirportId: row.origin_airport_id,
        origin: row.origin_code,
        destinationAirportId: row.destination_airport_id,
        destination: row.destination_code,
        aircraftId: row.aircraft_id,
        departureAt: row.departure_at.toISOString(),
        arrivalAt: row.arrival_at.toISOString(),
        fares,
        availableSeats: availability.reduce((total, entry) => total + entry.availableSeats, 0),
        status: toStoredFlightStatus(row.status),
        originTimeZone: row.origin_time_zone,
        destinationTimeZone: row.destination_time_zone,
        availability,
      };
      return details;
    },
  };
}
