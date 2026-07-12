import type { Flight } from "../types.js";

export type CreateFlightRepositoryResult =
  | { outcome: "created" }
  | { outcome: "duplicate" };

/**
 * Application-facing persistence contract.
 * No SQLite, Express, HTTP status, or snake_case rows.
 */
export interface FlightRepository {
  findAll(): Flight[];
  findById(id: string): Flight | undefined;
  create(flight: Flight): CreateFlightRepositoryResult;
}
