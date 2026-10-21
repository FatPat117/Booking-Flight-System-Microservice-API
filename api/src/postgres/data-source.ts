import "reflect-metadata";

import { DataSource } from "typeorm";

import { AircraftEntity } from "../aircraft/postgres/aircraft.entity.js";
import { SeatEntity } from "../aircraft/postgres/seat.entity.js";
import { AirportEntity } from "../airports/postgres/airport.entity.js";
import { AuditEntity } from "../audit/postgres/audit.entity.js";
import { BookingPassengerEntity } from "../bookings/postgres/booking-passenger.entity.js";
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
import { CreateFlightSeats1790465200000 } from "./migrations/1790465200000-CreateFlightSeats.js";
import { BackfillFlightSeats1790468800000 } from "./migrations/1790468800000-BackfillFlightSeats.js";
import { ContractFlightSeats1790472400000 } from "./migrations/1790472400000-ContractFlightSeats.js";
import { MoveBookingsToLifecycle1790476000000 } from "./migrations/1790476000000-MoveBookingsToLifecycle.js";
import { AddBookingReference1790479600000 } from "./migrations/1790479600000-AddBookingReference.js";
import { CreateBookingPassengers1790483200000 } from "./migrations/1790483200000-CreateBookingPassengers.js";
import { ContractBookingPassengers1790486800000 } from "./migrations/1790486800000-ContractBookingPassengers.js";
import { AllowHeldSeats1790490400000 } from "./migrations/1790490400000-AllowHeldSeats.js";
import { AddBookingHoldExpiryIndex1790494000000 } from "./migrations/1790494000000-AddBookingHoldExpiryIndex.js";
import { CreateFlightFares1790497600000 } from "./migrations/1790497600000-CreateFlightFares.js";
import { BackfillFlightFares1790501200000 } from "./migrations/1790501200000-BackfillFlightFares.js";
import { ContractFlightFares1790504800000 } from "./migrations/1790504800000-ContractFlightFares.js";
import { AddPassengerFareSnapshot1790508400000 } from "./migrations/1790508400000-AddPassengerFareSnapshot.js";

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
      BookingPassengerEntity,
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
      CreateFlightSeats1790465200000,
      BackfillFlightSeats1790468800000,
      ContractFlightSeats1790472400000,
      MoveBookingsToLifecycle1790476000000,
      AddBookingReference1790479600000,
      CreateBookingPassengers1790483200000,
      ContractBookingPassengers1790486800000,
      AllowHeldSeats1790490400000,
      AddBookingHoldExpiryIndex1790494000000,
      CreateFlightFares1790497600000,
      BackfillFlightFares1790501200000,
      ContractFlightFares1790504800000,
      AddPassengerFareSnapshot1790508400000,
    ],
  });
}
