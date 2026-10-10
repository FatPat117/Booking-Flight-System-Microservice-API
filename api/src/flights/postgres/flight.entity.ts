import { Column, Entity, PrimaryColumn, Unique } from "typeorm";

/**
 * TypeORM mapping only — schema truth lives in the hand-written migrations
 * (api/src/postgres/migrations), not in these decorators (synchronize:
 * false). departureAt/arrivalAt are TIMESTAMPTZ (Day 35 decision) so
 * `arrival_at > departure_at` is a real chronological comparison instead of
 * the ISO-string-ordering assumption the SQLite TEXT columns relied on.
 *
 * @PrimaryColumn, not @PrimaryGeneratedColumn: create-flight.ts already
 * assigns `id` via generateId() before calling FlightRepository.create() —
 * unlike identity's UserEntity, the database never generates this id.
 *
 * Day 46: origin/destination are airport ids (the codes come from a join),
 * aircraft_id is required, and status is the stored status only. The FKs,
 * CHECKs and the aircraft-schedule exclusion constraint live in the
 * ContractFlightReferences / AddAircraftScheduleExclusion migrations.
 */
@Entity({ name: "flights" })
@Unique("UQ_flights_flight_number_departure_at", [
  "flightNumber",
  "departureAt",
])
export class FlightEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "varchar", name: "flight_number" })
  flightNumber!: string;

  @Column({ type: "uuid", name: "origin_airport_id" })
  originAirportId!: string;

  @Column({ type: "uuid", name: "destination_airport_id" })
  destinationAirportId!: string;

  @Column({ type: "uuid", name: "aircraft_id" })
  aircraftId!: string;

  @Column({ type: "timestamptz", name: "departure_at" })
  departureAt!: Date;

  @Column({ type: "timestamptz", name: "arrival_at" })
  arrivalAt!: Date;

  @Column({ type: "integer", name: "price_in_cents" })
  priceInCents!: number;

  @Column({ type: "varchar" })
  currency!: string;

  @Column({ type: "integer", name: "available_seats" })
  availableSeats!: number;

  @Column({ type: "text" })
  status!: string;
}
