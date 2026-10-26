/**
 * A HELD booking was paid and is CONFIRMED: its seats are BOOKED (Day 49B,
 * domain-model Decision 14). The first event that means "this customer
 * really has these seats" — `booking-held` deliberately does not.
 *
 * New in Day 49B, so every field is required: there are no older messages
 * of this type to stay compatible with.
 */
export type BookingConfirmedMoney = {
  /** Integer in the currency's smallest unit — whole đồng for VND. */
  amount: number;
  currency: string;
};

export type BookingConfirmedPassenger = {
  name: string;
  seat: string;
  fareClass: string;
  price: BookingConfirmedMoney;
};

export type BookingConfirmedEvent = {
  eventId: string;
  correlationId: string;
  type: "booking.confirmed";
  occurredAt: string;
  booking: {
    id: string;
    reference: string;
    flightId: string;
    /** In booking order, 1 to 9. */
    passengers: BookingConfirmedPassenger[];
    total: BookingConfirmedMoney;
  };
  payment: {
    id: string;
    /** What was charged: always the booking total. */
    amount: BookingConfirmedMoney;
  };
};

function isMoney(value: unknown): value is BookingConfirmedMoney {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseBookingConfirmedEvent(
  payload: unknown,
):
  | { ok: true; event: BookingConfirmedEvent }
  | { ok: false; reason: string } {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "payload must be an object" };
  }

  const record = payload as Record<string, unknown>;

  if (record.type !== "booking.confirmed") {
    return { ok: false, reason: 'type must be "booking.confirmed"' };
  }

  for (const key of ["eventId", "correlationId", "occurredAt"] as const) {
    if (!isNonEmptyString(record[key])) {
      return { ok: false, reason: `${key} must be a non-empty string` };
    }
  }

  if (record.booking === null || typeof record.booking !== "object") {
    return { ok: false, reason: "booking must be an object" };
  }

  const booking = record.booking as Record<string, unknown>;

  for (const key of ["id", "reference", "flightId"] as const) {
    if (!isNonEmptyString(booking[key])) {
      return { ok: false, reason: `booking.${key} must be a non-empty string` };
    }
  }

  if (!Array.isArray(booking.passengers) || booking.passengers.length === 0) {
    return { ok: false, reason: "booking.passengers must be a non-empty array" };
  }

  const passengers: BookingConfirmedPassenger[] = [];

  for (const [index, value] of booking.passengers.entries()) {
    const passenger = (value ?? {}) as Record<string, unknown>;
    const { name, seat, fareClass, price } = passenger;
    if (
      !isNonEmptyString(name) ||
      !isNonEmptyString(seat) ||
      !isNonEmptyString(fareClass) ||
      !isMoney(price)
    ) {
      return {
        ok: false,
        reason: `booking.passengers[${index}] must have a name, seat, fareClass and price`,
      };
    }
    passengers.push({
      name,
      seat,
      fareClass,
      price: { amount: price.amount, currency: price.currency },
    });
  }

  if (!isMoney(booking.total)) {
    return {
      ok: false,
      reason: "booking.total must have an integer amount and a currency",
    };
  }

  if (record.payment === null || typeof record.payment !== "object") {
    return { ok: false, reason: "payment must be an object" };
  }

  const payment = record.payment as Record<string, unknown>;

  if (!isNonEmptyString(payment.id)) {
    return { ok: false, reason: "payment.id must be a non-empty string" };
  }

  if (!isMoney(payment.amount)) {
    return {
      ok: false,
      reason: "payment.amount must have an integer amount and a currency",
    };
  }

  return {
    ok: true,
    event: {
      eventId: record.eventId as string,
      correlationId: record.correlationId as string,
      type: "booking.confirmed",
      occurredAt: record.occurredAt as string,
      booking: {
        id: booking.id as string,
        reference: booking.reference as string,
        flightId: booking.flightId as string,
        passengers,
        total: { amount: booking.total.amount, currency: booking.total.currency },
      },
      payment: {
        id: payment.id,
        amount: { amount: payment.amount.amount, currency: payment.amount.currency },
      },
    },
  };
}
