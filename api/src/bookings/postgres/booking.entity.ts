import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * TypeORM mapping only — schema truth lives in the hand-written migration
 * (api/src/postgres/migrations), not in these decorators (synchronize:
 * false). See that migration for the FK/index/CHECK reasoning.
 *
 * @PrimaryColumn, not @PrimaryGeneratedColumn: create-booking.ts already
 * assigns `id` via generateId() before calling BookingRepository.create() —
 * same reason as FlightEntity/OutboxEntity/AuditEntity.
 *
 * status stays a plain string here (not a TypeORM enum column) — the CHECK
 * constraint in the migration is the actual guardrail; BookingStatus
 * (booking-repository.ts) is the TypeScript-side one.
 */
@Entity({ name: "bookings" })
export class BookingEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "flight_id" })
  flightId!: string;

  @Column({ type: "uuid", name: "owner_account_id" })
  ownerAccountId!: string;

  @Column({ type: "varchar", name: "passenger_name" })
  passengerName!: string;

  @Column({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;

  @Column({ type: "varchar" })
  status!: string;
}
