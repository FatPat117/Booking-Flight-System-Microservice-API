import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * TypeORM mapping only — constraints live in the hand-written migration
 * (CreateAirportsAndAircraft). `id` is assigned by the use case, like every
 * other entity here.
 */
@Entity({ name: "airports" })
export class AirportEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  code!: string;

  @Column({ type: "text" })
  name!: string;

  @Column({ type: "text" })
  city!: string;

  @Column({ type: "text", name: "time_zone" })
  timeZone!: string;

  @Column({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
