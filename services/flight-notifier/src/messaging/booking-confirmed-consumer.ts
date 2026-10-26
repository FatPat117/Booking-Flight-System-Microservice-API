import { parseBookingConfirmedEvent } from "@booking-flight-system/contracts";
import type { Logger } from "../observability/logger.js";
import type {
  MessageHandler,
  MessageHandlerResult,
} from "./message-consumer.js";

/** Logs the reference, passenger count and what was paid; no names. */
export function createBookingConfirmedConsumer(deps: {
  logger: Logger;
}): MessageHandler {
  return async (payload: unknown): Promise<MessageHandlerResult> => {
    const parsed = parseBookingConfirmedEvent(payload);

    if (!parsed.ok) {
      return { outcome: "rejected", reason: parsed.reason };
    }

    const { event } = parsed;

    deps.logger.info("booking_confirmed_consumed", {
      eventId: event.eventId,
      correlationId: event.correlationId,
      bookingId: event.booking.id,
      reference: event.booking.reference,
      flightId: event.booking.flightId,
      passengerCount: event.booking.passengers.length,
      paymentId: event.payment.id,
      amount: event.payment.amount.amount,
      currency: event.payment.amount.currency,
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}
