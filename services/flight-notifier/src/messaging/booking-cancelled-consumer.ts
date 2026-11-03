import { parseBookingCancelledEvent } from "@booking-flight-system/contracts";
import type { Logger } from "../observability/logger.js";
import type {
  MessageHandler,
  MessageHandlerResult,
} from "./message-consumer.js";

/**
 * Logs the reference, the released seat count and whether a refund was
 * started (Day 50); the event has no names. A refund here means "started":
 * the api's reconciliation job makes it.
 */
export function createBookingCancelledConsumer(deps: {
  logger: Logger;
}): MessageHandler {
  return async (payload: unknown): Promise<MessageHandlerResult> => {
    const parsed = parseBookingCancelledEvent(payload);

    if (!parsed.ok) {
      return { outcome: "rejected", reason: parsed.reason };
    }

    const { event } = parsed;

    deps.logger.info("booking_cancelled_consumed", {
      eventId: event.eventId,
      correlationId: event.correlationId,
      bookingId: event.booking.id,
      reference: event.booking.reference,
      flightId: event.booking.flightId,
      seatCount: event.booking.seats.length,
      refundPaymentId: event.refund?.paymentId ?? null,
      refundAmount: event.refund?.amount.amount ?? null,
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}
