import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * TypeORM mapping only — schema truth is the CreateBookingPassengers
 * migration (UQ on position and on seat per booking, CHECKs).
 *
 * seatRow / seatLetter are a display copy (Decision 11): the seats a booking
 * holds are flight_seats rows with its booking_id.
 */
@Entity({ name: "booking_passengers" })
export class BookingPassengerEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "booking_id" })
  bookingId!: string;

  @Column({ type: "smallint" })
  position!: number;

  @Column({ type: "text" })
  name!: string;

  @Column({ type: "smallint", name: "seat_row", nullable: true })
  seatRow!: number | null;

  @Column({ type: "character", length: 1, name: "seat_letter", nullable: true })
  seatLetter!: string | null;
}
