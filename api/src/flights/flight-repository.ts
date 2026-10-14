import type { FareClass } from "../aircraft/seat-layout.js";
import type { SeatPosition } from "../aircraft/seat-position.js";
import type { Flight } from "../types.js";
import type { StoredFlightStatus } from "./flight-lifecycle.js";

export type FlightSeatStatus = "AVAILABLE" | "BOOKED";

/**
 * One seat of a flight's inventory as anyone may see it. Deliberately
 * without the booking that holds it: the seat map is public, and who sits
 * where is not (Decision 10).
 */
export type FlightSeat = Readonly<{
  position: SeatPosition;
  fareClass: FareClass;
  status: FlightSeatStatus;
}>;

/**
 * - duplicate: flight number + departure instant taken (BR-FLT-04)
 * - aircraft-unavailable: the aircraft's occupancy window overlaps another
 *   non-cancelled flight's (BR-FLT-03/08) — decided by the database's
 *   exclusion constraint, not by a prior SELECT, so it holds under
 *   concurrent admins
 * - reference-not-found: the airport or aircraft id does not exist (the use
 *   case resolves them first, so this means one vanished in between)
 */
export type CreateFlightRepositoryResult =
  | { outcome: "created" }
  | { outcome: "duplicate" }
  | { outcome: "aircraft-unavailable" }
  | { outcome: "reference-not-found" };

/**
 * Compare-and-set on the stored status (ADR-004 applied to a lifecycle):
 * `status-changed` means another writer got there first, and carries the
 * status it left behind.
 */
export type ChangeFlightStatusResult =
  | { outcome: "changed" }
  | { outcome: "not-found" }
  | { outcome: "status-changed"; current: StoredFlightStatus };

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
 * - database driver types (DataSource, TypeORM entities)
 * - snake_case database rows
 */
export interface FlightRepository {
  findPage(request: FlightPageRequest): Promise<FlightPage>;

  findById(id: string): Promise<Flight | undefined>;

  /**
   * The flight's seats in (row, letter) order; undefined when the flight
   * does not exist (an existing flight with no seats is `[]`).
   */
  findSeats(flightId: string): Promise<FlightSeat[] | undefined>;

  /**
   * Stores the airport and aircraft ids; `origin`/`destination` codes on the
   * argument are not stored (reads take them from `airports`).
   *
   * Also stores the flight's seat inventory, copied from its aircraft's
   * layout, all AVAILABLE — in the same transaction: a flight never exists
   * without its seats (Decision 10). `availableSeats` on the argument is not
   * stored either; reads count it.
   */
  create(flight: Flight): Promise<CreateFlightRepositoryResult>;

  /**
   * One conditional UPDATE: changes the status only if it is still
   * `expected`. Never read-then-write — the caller's `expected` is the status
   * its transition check was made against.
   */
  changeStatus(
    flightId: string,
    expected: StoredFlightStatus,
    next: StoredFlightStatus,
  ): Promise<ChangeFlightStatusResult>;
}
