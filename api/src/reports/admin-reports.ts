import type { FareClass } from "../aircraft/seat-layout.js";
import type { StoredFlightStatus } from "../flights/flight-lifecycle.js";

/**
 * The read side of the admin reports (US-ADM-01..03, Decision 19): a port of
 * its own, like FlightSearch (Decision 17), because each report has a shape
 * of its own and reads across flights, seats, bookings and the audit log.
 * Nothing here writes; the manifest view's audit entry is the use case's.
 *
 * Must not know about: Express, HTTP status, cursors as strings (the use
 * cases encode them), SQL or TypeORM types, effective flight statuses or
 * ratios (the use cases derive them from the stored values below).
 */
export interface AdminReports {
  /**
   * One flight's manifest, from one snapshot: the per-class counts and the
   * passenger list agree with each other even while bookings change.
   * `undefined` when no flight has this id. `now` decides which holds are
   * still valid.
   */
  findManifest(flightId: string, now: Date): Promise<FlightManifest | undefined>;
  /** One page of flights departing on the query's local dates. One statement. */
  loadFactor(query: LoadFactorQuery, now: Date): Promise<LoadFactorPage>;
  /** One page of audit entries, newest first. One statement. */
  auditLog(query: AuditLogQuery): Promise<AuditLogPage>;
}

/** Where the previous page ended: its last item's sort key. */
export type ReportKey = Readonly<{ at: string; id: string }>;

export type ReportFlight = Readonly<{
  id: string;
  flightNumber: string;
  origin: string;
  originTimeZone: string;
  destination: string;
  departureAt: string;
  status: StoredFlightStatus;
}>;

/**
 * Seats of one fare class. `held` counts HELD seats whose hold is still
 * valid; a seat of a lapsed hold the job has not swept is `available`
 * (Decision 12). So `available + held + booked = total`.
 */
export type ClassSeats = Readonly<{
  fareClass: FareClass;
  total: number;
  booked: number;
  held: number;
  available: number;
}>;

/**
 * A CONFIRMED booking's passenger as boarding needs it, and nothing more
 * (Decision 19): no price, no owner, no booking id. `seat` and `fareClass`
 * are null only for a legacy booking, which is never CONFIRMED.
 */
export type ManifestPassenger = Readonly<{
  reference: string;
  name: string;
  seat: string | null;
  fareClass: FareClass | null;
}>;

export type FlightManifest = Readonly<{
  flight: ReportFlight;
  /** Every fare class of the flight's seats, BUSINESS before ECONOMY. */
  classes: readonly ClassSeats[];
  /** HELD bookings with a valid hold: counted, never named. */
  heldBookings: number;
  /** In seat order (row, then letter). */
  passengers: readonly ManifestPassenger[];
}>;

/**
 * Flights whose departure falls on `dateFrom`..`dateTo` (inclusive), each
 * date read in the flight's own origin zone; optionally one origin.
 */
export type LoadFactorQuery = Readonly<{
  dateFrom: string;
  dateTo: string;
  origin?: string;
  limit: number;
  /** Continue after this `(departureAt, id)`. */
  after?: ReportKey;
}>;

export type LoadFactorFlight = ReportFlight & Readonly<{ classes: readonly ClassSeats[] }>;

export type LoadFactorPage = Readonly<{
  items: readonly LoadFactorFlight[];
  hasNextPage: boolean;
}>;

/**
 * A target, a time range `[from, to)`, or both (the use case requires one,
 * so an index can serve the query); actor and action only narrow it.
 */
export type AuditLogQuery = Readonly<{
  target?: Readonly<{ type: string; id: string }>;
  range?: Readonly<{ from: string; to: string }>;
  actorType?: string;
  actorId?: string;
  action?: string;
  limit: number;
  /** Continue after (older than) this `(occurredAt, id)`. */
  after?: ReportKey;
}>;

export type AuditLogEntry = Readonly<{
  id: string;
  action: string;
  actor: Readonly<{ type: string; id: string }>;
  target: Readonly<{ type: string; id: string }>;
  requestId: string | null;
  occurredAt: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type AuditLogPage = Readonly<{
  items: readonly AuditLogEntry[];
  hasNextPage: boolean;
}>;
