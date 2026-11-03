/**
 * Its owner cancelled a booking: it is CANCELLED and its seats are free
 * again (Day 28 in the outbox; a contract since Day 50, domain-model
 * Decision 16). `refund` is set when the booking had been paid: its payment
 * is now REFUND_PENDING and the reconciliation job refunds it — this event
 * says a refund was started, not that it finished. No passenger names.
 *
 * Messages sent before Day 50 carried only `booking.id` and
 * `booking.flightId`; they fail this schema and go to the DLQ.
 */
export type BookingCancelledMoney = {
  /** Integer in the currency's smallest unit — whole đồng for VND. */
  amount: number;
  currency: string;
};

export type BookingCancelledEvent = {
  eventId: string;
  correlationId: string;
  type: "booking.cancelled";
  occurredAt: string;
  booking: {
    id: string;
    reference: string;
    flightId: string;
    /** Seat codes released, (row, letter) order; 1 to 9. */
    seats: string[];
  };
  refund: {
    paymentId: string;
    /** The full amount paid: there are no partial refunds (Day 43 Won't). */
    amount: BookingCancelledMoney;
  } | null;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMoney(value: unknown): value is BookingCancelledMoney {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.amount === "number" &&
    Number.isSafeInteger(record.amount) &&
    record.amount >= 0 &&
    isNonEmptyString(record.currency)
  );
}

export function parseBookingCancelledEvent(
  payload: unknown,
):
  | { ok: true; event: BookingCancelledEvent }
  | { ok: false; reason: string } {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "payload must be an object" };
  }

  const record = payload as Record<string, unknown>;

  if (record.type !== "booking.cancelled") {
    return { ok: false, reason: 'type must be "booking.cancelled"' };
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

  if (
    !Array.isArray(booking.seats) ||
    booking.seats.length === 0 ||
    !booking.seats.every(isNonEmptyString)
  ) {
    return {
      ok: false,
      reason: "booking.seats must be a non-empty array of seat codes",
    };
  }

  // Required, possibly null: a missing key is a producer bug, not "unpaid".
  if (!("refund" in record)) {
    return { ok: false, reason: "refund must be present (an object or null)" };
  }

  let refund: BookingCancelledEvent["refund"] = null;
  if (record.refund !== null) {
    const raw = record.refund as Record<string, unknown> | undefined;
    if (
      raw === undefined ||
      typeof raw !== "object" ||
      !isNonEmptyString(raw.paymentId) ||
      !isMoney(raw.amount)
    ) {
      return {
        ok: false,
        reason: "refund must be null or have a paymentId and an amount",
      };
    }
    refund = {
      paymentId: raw.paymentId,
      amount: { amount: raw.amount.amount, currency: raw.amount.currency },
    };
  }

  return {
    ok: true,
    event: {
      eventId: record.eventId as string,
      correlationId: record.correlationId as string,
      type: "booking.cancelled",
      occurredAt: record.occurredAt as string,
      booking: {
        id: booking.id as string,
        reference: booking.reference as string,
        flightId: booking.flightId as string,
        seats: [...(booking.seats as string[])],
      },
      refund,
    },
  };
}
