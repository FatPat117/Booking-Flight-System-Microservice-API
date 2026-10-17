import { parseBookingExpiredEvent } from "@booking-flight-system/contracts";
import type { Logger } from "../observability/logger.js";
import type {
  MessageHandler,
  MessageHandlerResult,
} from "./message-consumer.js";

/** Logs the reference and the released seat count; the event has no names. */
export function createBookingExpiredConsumer(deps: {
  logger: Logger;
}): MessageHandler {
  return async (payload: unknown): Promise<MessageHandlerResult> => {
    const parsed = parseBookingExpiredEvent(payload);

    if (!parsed.ok) {
      return { outcome: "rejected", reason: parsed.reason };
    }

    const { event } = parsed;

    deps.logger.info("booking_expired_consumed", {
      eventId: event.eventId,
      correlationId: event.correlationId,
      bookingId: event.booking.id,
      reference: event.booking.reference,
      flightId: event.booking.flightId,
      seatCount: event.booking.seats.length,
      holdExpiresAt: event.booking.holdExpiresAt,
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}
