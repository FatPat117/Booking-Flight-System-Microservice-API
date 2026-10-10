import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * One seat of an aircraft's layout. The composite primary key
 * (aircraft_id, row, letter) is BR-REF-03 enforced by the database.
 * No status column: availability belongs to FlightSeat (glossary).
 */
@Entity({ name: "seats" })
export class SeatEntity {
  @PrimaryColumn({ type: "uuid", name: "aircraft_id" })
  aircraftId!: string;

  @PrimaryColumn({ type: "smallint" })
  row!: number;

  @PrimaryColumn({ type: "char", length: 1 })
  letter!: string;

  @Column({ type: "text", name: "fare_class" })
  fareClass!: string;
}
