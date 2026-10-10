import "reflect-metadata";

import { DataSource } from "typeorm";

import { AircraftEntity } from "../aircraft/postgres/aircraft.entity.js";
import { SeatEntity } from "../aircraft/postgres/seat.entity.js";
import { AirportEntity } from "../airports/postgres/airport.entity.js";
import { AuditEntity } from "../audit/postgres/audit.entity.js";
import { BookingEntity } from "../bookings/postgres/booking.entity.js";
import { FlightEntity } from "../flights/postgres/flight.entity.js";
import { OutboxEntity } from "../outbox/postgres/outbox.entity.js";
import type { PostgresConfig } from "./config.js";
import { CreateFlights1790424994000 } from "./migrations/1790424994000-CreateFlights.js";
import { CreateOutbox1790428672000 } from "./migrations/1790428672000-CreateOutbox.js";
import { CreateAuditLogs1790432350000 } from "./migrations/1790432350000-CreateAuditLogs.js";
import { CreateBookings1790436000000 } from "./migrations/1790436000000-CreateBookings.js";
import { AddBookingOwner1790440000000 } from "./migrations/1790440000000-AddBookingOwner.js";
import { RequireBookingOwner1790443600000 } from "./migrations/1790443600000-RequireBookingOwner.js";
import { CreateAirportsAndAircraft1790447200000 } from "./migrations/1790447200000-CreateAirportsAndAircraft.js";
import { ExpandFlightReferences1790450800000 } from "./migrations/1790450800000-ExpandFlightReferences.js";
import { BackfillFlightReferences1790454400000 } from "./migrations/1790454400000-BackfillFlightReferences.js";
import { ContractFlightReferences1790458000000 } from "./migrations/1790458000000-ContractFlightReferences.js";
import { AddAircraftScheduleExclusion1790461600000 } from "./migrations/1790461600000-AddAircraftScheduleExclusion.js";

/**
 * Day 36+ — dev-complete only. Entities/migrations are added per Strangler
 * Fig step (FlightEntity, then Outbox); this DataSource is not constructed
 * by bootstrap/application.ts until the combined cutover
 * (docs/migration-plan-postgres.md Section 5.2).
 */
export function createBookingDataSource(config: PostgresConfig): DataSource {
  return new DataSource({
    type: "postgres",
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    // Never true outside throwaway local experiments — migrations own schema.
    synchronize: false,
    // Day 46: one transaction per migration, not one for the whole batch.
    // Expand / backfill / contract are separate steps: when a contract
    // refuses (NULLs left), the expand before it must stay applied so the
    // operator has the new columns to backfill by hand before re-running.
    migrationsTransactionMode: "each",
    entities: [
      FlightEntity,
      OutboxEntity,
      AuditEntity,
      BookingEntity,
      AirportEntity,
      AircraftEntity,
      SeatEntity,
    ],
    migrations: [
      CreateFlights1790424994000,
      CreateOutbox1790428672000,
      CreateAuditLogs1790432350000,
      CreateBookings1790436000000,
      AddBookingOwner1790440000000,
      RequireBookingOwner1790443600000,
      CreateAirportsAndAircraft1790447200000,
      ExpandFlightReferences1790450800000,
      BackfillFlightReferences1790454400000,
      ContractFlightReferences1790458000000,
      AddAircraftScheduleExclusion1790461600000,
    ],
  });
}
