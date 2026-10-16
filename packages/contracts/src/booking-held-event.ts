/**
 * A booking now holds seats for 15 minutes, unpaid (Day 48A, domain-model
 * Decision 11). Not "booking confirmed": the hold may expire. Replaces
 * `booking.created` for new bookings; `booking-confirmed` is reserved for
 * payment.
 */
export type BookingHeldEvent = {
  eventId: string;
  correlationId: string;
  type: "booking.held";
  occurredAt: string;
  booking: {
    id: string;
    reference: string;
    flightId: string;
    createdAt: string;
    holdExpiresAt: string;
    /** In booking order, 1 to 9; each with the seat code held for them. */
    passengers: Array<{ name: string; seat: string }>;
  };
};

export function parseBookingHeldEvent(
  payload: unknown,
):
  | { ok: true; event: BookingHeldEvent }
  | { ok: false; reason: string } {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "payload must be an object" };
  }

  const record = payload as Record<string, unknown>;

  if (record.type !== "booking.held") {
    return { ok: false, reason: 'type must be "booking.held"' };
  }

  if (typeof record.eventId !== "string" || record.eventId.length === 0) {
    return { ok: false, reason: "eventId must be a non-empty string" };
  }

  if (
    typeof record.correlationId !== "string" ||
    record.correlationId.length === 0
  ) {
    return { ok: false, reason: "correlationId must be a non-empty string" };
  }

  if (typeof record.occurredAt !== "string" || record.occurredAt.length === 0) {
    return { ok: false, reason: "occurredAt must be a non-empty string" };
  }

  if (record.booking === null || typeof record.booking !== "object") {
    return { ok: false, reason: "booking must be an object" };
  }

  const booking = record.booking as Record<string, unknown>;
  const requiredStrings = [
    "id",
    "reference",
    "flightId",
    "createdAt",
    "holdExpiresAt",
  ] as const;

  for (const key of requiredStrings) {
    if (typeof booking[key] !== "string" || booking[key].length === 0) {
      return {
        ok: false,
        reason: `booking.${key} must be a non-empty string`,
      };
    }
  }

  if (!Array.isArray(booking.passengers) || booking.passengers.length === 0) {
    return { ok: false, reason: "booking.passengers must be a non-empty array" };
  }

  const passengers: Array<{ name: string; seat: string }> = [];

  for (const [index, value] of booking.passengers.entries()) {
    const passenger = (value ?? {}) as Record<string, unknown>;
    if (
      typeof passenger.name !== "string" ||
      passenger.name.length === 0 ||
      typeof passenger.seat !== "string" ||
      passenger.seat.length === 0
    ) {
      return {
        ok: false,
        reason: `booking.passengers[${index}] must have a non-empty name and seat`,
      };
    }
    passengers.push({ name: passenger.name, seat: passenger.seat });
  }

  return {
    ok: true,
    event: {
      eventId: record.eventId,
      correlationId: record.correlationId,
      type: "booking.held",
      occurredAt: record.occurredAt,
      booking: {
        id: booking.id as string,
        reference: booking.reference as string,
        flightId: booking.flightId as string,
        createdAt: booking.createdAt as string,
        holdExpiresAt: booking.holdExpiresAt as string,
        passengers,
      },
    },
  };
}
