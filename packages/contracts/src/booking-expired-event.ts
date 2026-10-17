/**
 * A HELD booking's 15 minutes ran out unpaid: it is EXPIRED and its seats
 * are free again (Day 48B, domain-model Decision 12). Sent by the expiry
 * job, so there is no request behind it: `correlationId` is the event's own
 * id. `occurredAt` is when the job expired it, which can be up to one job
 * interval after `holdExpiresAt`. No passenger names.
 */
export type BookingExpiredEvent = {
  eventId: string;
  correlationId: string;
  type: "booking.expired";
  occurredAt: string;
  booking: {
    id: string;
    reference: string;
    flightId: string;
    holdExpiresAt: string;
    /** Seat codes released, (row, letter) order; 1 to 9. */
    seats: string[];
  };
};

export function parseBookingExpiredEvent(
  payload: unknown,
):
  | { ok: true; event: BookingExpiredEvent }
  | { ok: false; reason: string } {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "payload must be an object" };
  }

  const record = payload as Record<string, unknown>;

  if (record.type !== "booking.expired") {
    return { ok: false, reason: 'type must be "booking.expired"' };
  }

  for (const key of ["eventId", "correlationId", "occurredAt"] as const) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, reason: `${key} must be a non-empty string` };
    }
  }

  if (record.booking === null || typeof record.booking !== "object") {
    return { ok: false, reason: "booking must be an object" };
  }

  const booking = record.booking as Record<string, unknown>;

  for (const key of ["id", "reference", "flightId", "holdExpiresAt"] as const) {
    const value = booking[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, reason: `booking.${key} must be a non-empty string` };
    }
  }

  if (
    !Array.isArray(booking.seats) ||
    booking.seats.length === 0 ||
    !booking.seats.every((seat) => typeof seat === "string" && seat.length > 0)
  ) {
    return {
      ok: false,
      reason: "booking.seats must be a non-empty array of seat codes",
    };
  }

  return {
    ok: true,
    event: {
      eventId: record.eventId as string,
      correlationId: record.correlationId as string,
      type: "booking.expired",
      occurredAt: record.occurredAt as string,
      booking: {
        id: booking.id as string,
        reference: booking.reference as string,
        flightId: booking.flightId as string,
        holdExpiresAt: booking.holdExpiresAt as string,
        seats: [...(booking.seats as string[])],
      },
    },
  };
}
