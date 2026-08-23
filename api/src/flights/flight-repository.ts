import type { Flight } from "../types.js";

export type CreateFlightRepositoryResult =
  | {
      outcome: "created";
    }
  | {
      outcome: "duplicate";
    };

/**
 * Storage-level pagination request.
 *
 * The repository does not know about page/pageSize.
 * It only knows how many rows to take and how many to skip.
 */
export type FlightPageRequest = {
  limit: number;
  offset: number;
};

/**
 * Result of a page query.
 *
 * totalItems is the total number of flights in the collection,
 * not the number of items on the current page.
 */
export type FlightPage = {
  items: Flight[];
  totalItems: number;
};

/**
 * Application-facing persistence contract.
 *
 * Does not contain:
 * - Express Request/Response
 * - HTTP status
 * - SQLite DatabaseSync
 * - snake_case database rows
 */
export interface FlightRepository {
  findPage(request: FlightPageRequest): FlightPage;

  findById(id: string): Flight | undefined;

  create(flight: Flight): CreateFlightRepositoryResult;
}
