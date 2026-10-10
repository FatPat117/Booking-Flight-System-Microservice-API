import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * TypeORM mapping only — constraints live in the hand-written migration
 * (CreateAirportsAndAircraft). Seats are a separate entity, written in the
 * same transaction.
 */
@Entity({ name: "aircraft" })
export class AircraftEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  registration!: string;

  @Column({ type: "text" })
  model!: string;

  @Column({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
