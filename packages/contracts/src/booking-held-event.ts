/**
 * A booking now holds seats for 15 minutes, unpaid (Day 48A, domain-model
 * Decision 11). Not "booking confirmed": the hold may expire. Replaces
 * `booking.created` for new bookings; `booking-confirmed` is reserved for
 * payment.
 *
 * Day 49A added each passenger's `fareClass` and `price` and the booking's
 * `total` (BR-BOOK-03). The producer always sends them; they are optional
 * here because Day 48A messages may still sit in the queue or the DLQ.
 */
export type BookingHeldMoney = {
  /** Integer in the currency's smallest unit — whole đồng for VND. */
  amount: number;
  currency: string;
};

export type BookingHeldPassenger = {
  name: string;
  seat: string;
  fareClass?: string;
  price?: BookingHeldMoney;
};

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
    passengers: BookingHeldPassenger[];
    /** The sum of the passengers' prices; absent before Day 49A. */
    total?: BookingHeldMoney;
  };
};

function isMoney(value: unknown): value is BookingHeldMoney {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.amount === "number" &&
    Number.isSafeInteger(record.amount) &&
    record.amount >= 0 &&
    typeof record.currency === "string" &&
    record.currency.length > 0
  );
}

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

  const passengers: BookingHeldPassenger[] = [];

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
    // Absent is the Day 48A shape and fine; present but malformed is a
    // broken producer.
    const { fareClass, price } = passenger;
    if (
      fareClass !== undefined &&
      (typeof fareClass !== "string" || fareClass.length === 0)
    ) {
      return {
        ok: false,
        reason: `booking.passengers[${index}].fareClass must be a non-empty string when present`,
      };
    }
    if (price !== undefined && !isMoney(price)) {
      return {
        ok: false,
        reason: `booking.passengers[${index}].price must have an integer amount and a currency when present`,
      };
    }
    passengers.push({
      name: passenger.name,
      seat: passenger.seat,
      ...(fareClass === undefined ? {} : { fareClass }),
      ...(price === undefined ? {} : { price: { amount: price.amount, currency: price.currency } }),
    });
  }

  const total = booking.total;
  if (total !== undefined && !isMoney(total)) {
    return {
      ok: false,
      reason: "booking.total must have an integer amount and a currency when present",
    };
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
        ...(total === undefined
          ? {}
          : { total: { amount: total.amount, currency: total.currency } }),
      },
    },
  };
}
