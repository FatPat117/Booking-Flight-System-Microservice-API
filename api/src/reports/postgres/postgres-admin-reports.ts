import type { DataSource } from "typeorm";

import type { FareClass } from "../../aircraft/seat-layout.js";
import { toStoredFlightStatus } from "../../flights/flight-lifecycle.js";
import { isInTransaction, resolveEntityManager } from "../../postgres/transaction-context.js";
import { NestedTransactionError } from "../../transactions/postgres-transaction-runner.js";
import type {
  AdminReports,
  AuditLogEntry,
  ClassSeats,
  FlightManifest,
  ReportFlight,
} from "../admin-reports.js";
import {
  MANIFEST_FLIGHT_SQL,
  MANIFEST_PASSENGERS_SQL,
  auditLogSql,
  loadFactorSql,
} from "./admin-reports-sql.js";

type FlightRow = {
  id: string;
  flight_number: string;
  departure_at: Date;
  status: string;
  origin_code: string;
  origin_time_zone: string;
  destination_code: string;
  classes: Array<ClassSeats & { fareClass: string }>;
};

type PassengerRow = {
  reference: string;
  name: string;
  seat_row: number | null;
  seat_letter: string | null;
  fare_class: string | null;
};

type AuditRow = {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  request_id: string | null;
  occurred_at: Date;
  metadata: Record<string, unknown>;
};

function mapFlight(row: FlightRow): ReportFlight {
  return {
    id: row.id,
    flightNumber: row.flight_number,
    origin: row.origin_code,
    originTimeZone: row.origin_time_zone,
    destination: row.destination_code,
    departureAt: row.departure_at.toISOString(),
    status: toStoredFlightStatus(row.status),
  };
}

function mapClasses(row: FlightRow): ClassSeats[] {
  return row.classes.map((entry) => ({
    // CHK_flight_seats_fare_class guarantees the value set.
    fareClass: entry.fareClass as FareClass,
    total: entry.total,
    booked: entry.booked,
    held: entry.held,
    available: entry.available,
  }));
}

function mapAudit(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    action: row.action,
    actor: { type: row.actor_type, id: row.actor_id },
    target: { type: row.target_type, id: row.target_id },
    requestId: row.request_id,
    occurredAt: row.occurred_at.toISOString(),
    metadata: row.metadata,
  };
}

export type PostgresAdminReportsOptions = Readonly<{
  /**
   * Test seam (Day 53 race test): runs inside the manifest's transaction,
   * between its two statements. Production passes nothing.
   */
  betweenManifestStatements?: () => Promise<void>;
}>;

/**
 * Decision 19. The load factor and the audit log are one statement per
 * page. The manifest is two, so it runs them in a transaction of its own,
 * REPEATABLE READ READ ONLY: both see the snapshot taken at the first, so
 * the counts and the passenger list agree even while bookings change. A
 * read-only REPEATABLE READ transaction never fails with a serialization
 * error, so there is nothing to retry. It opens its own transaction, so it
 * refuses to run inside another one (whose snapshot it would not control).
 */
export function createPostgresAdminReports(
  dataSource: DataSource,
  options: PostgresAdminReportsOptions = {},
): AdminReports {
  return {
    async findManifest(flightId, now) {
      if (isInTransaction()) {
        throw new NestedTransactionError();
      }
      return dataSource.transaction("REPEATABLE READ", async (manager): Promise<FlightManifest | undefined> => {
        await manager.query("SET TRANSACTION READ ONLY");
        const [flight] = (await manager.query(MANIFEST_FLIGHT_SQL, [flightId, now])) as Array<
          FlightRow & { held_bookings: number }
        >;
        if (flight === undefined) {
          return undefined;
        }
        await options.betweenManifestStatements?.();
        const passengers = (await manager.query(MANIFEST_PASSENGERS_SQL, [flightId])) as PassengerRow[];

        return {
          flight: mapFlight(flight),
          classes: mapClasses(flight),
          heldBookings: flight.held_bookings,
          passengers: passengers.map((row) => ({
            reference: row.reference,
            name: row.name,
            seat: row.seat_row === null || row.seat_letter === null ? null : `${row.seat_row}${row.seat_letter}`,
            fareClass: row.fare_class as FareClass | null,
          })),
        };
      });
    },

    async loadFactor(query, now) {
      const parameters: unknown[] = [query.dateFrom, query.dateTo, query.origin ?? null, query.limit + 1, now];
      if (query.after !== undefined) {
        parameters.push(query.after.at, query.after.id);
      }
      const rows = (await resolveEntityManager(dataSource).query(
        loadFactorSql(query.after !== undefined),
        parameters,
      )) as FlightRow[];
      return {
        items: rows.slice(0, query.limit).map((row) => ({ ...mapFlight(row), classes: mapClasses(row) })),
        hasNextPage: rows.length > query.limit,
      };
    },

    async auditLog(query) {
      const { sql, parameters } = auditLogSql(query);
      const rows = (await resolveEntityManager(dataSource).query(sql, parameters)) as AuditRow[];
      return {
        items: rows.slice(0, query.limit).map(mapAudit),
        hasNextPage: rows.length > query.limit,
      };
    },
  };
}
