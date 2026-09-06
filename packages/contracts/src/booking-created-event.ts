export type BookingCreatedEvent = {
  eventId: string;
  correlationId: string;
  type: "booking.created";
  occurredAt: string;
  booking: {
    id: string;
    flightId: string;
    passengerName: string;
    createdAt: string;
  };
};

export function parseBookingCreatedEvent(
  payload: unknown,
):
  | { ok: true; event: BookingCreatedEvent }
  | { ok: false; reason: string } {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "payload must be an object" };
  }

  const record = payload as Record<string, unknown>;

  if (record.type !== "booking.created") {
    return { ok: false, reason: 'type must be "booking.created"' };
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
    "flightId",
    "passengerName",
    "createdAt",
  ] as const;

  for (const key of requiredStrings) {
    if (typeof booking[key] !== "string" || booking[key].length === 0) {
      return {
        ok: false,
        reason: `booking.${key} must be a non-empty string`,
      };
    }
  }

  return {
    ok: true,
    event: {
      eventId: record.eventId,
      correlationId: record.correlationId,
      type: "booking.created",
      occurredAt: record.occurredAt,
      booking: {
        id: booking.id as string,
        flightId: booking.flightId as string,
        passengerName: booking.passengerName as string,
        createdAt: booking.createdAt as string,
      },
    },
  };
}
