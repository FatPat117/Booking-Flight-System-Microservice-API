import type { LayoutSeat } from "./seat-layout.js";

/**
 * The Aircraft aggregate: the aircraft and its seat layout, always read and
 * written together (domain-model, "Aggregates and invariants").
 */
export type Aircraft = Readonly<{
  id: string;
  /** Already normalized to upper case (normalizeRegistration). */
  registration: string;
  model: string;
  createdAt: string;
  seats: readonly LayoutSeat[];
}>;

export type CreateAircraftResult =
  | { outcome: "created" }
  | { outcome: "duplicate" };

/**
 * Application-facing persistence contract for aircraft (reference data).
 *
 * Does not contain:
 * - Express Request/Response or HTTP status
 * - database driver types (DataSource, TypeORM entities)
 * - snake_case rows
 *
 * create() is atomic: the aircraft and every seat are stored, or nothing is.
 * `duplicate` means the registration is taken (BR-REF-02). Two seats at the
 * same position are not an outcome but a thrown error: expandSeatLayout
 * already rejects them, so reaching storage with one is a programmer error.
 */
export interface AircraftRepository {
  create(aircraft: Aircraft): Promise<CreateAircraftResult>;

  /** Seats ordered by row, then letter. */
  findById(id: string): Promise<Aircraft | undefined>;
}
