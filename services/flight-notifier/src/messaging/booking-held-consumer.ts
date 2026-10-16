import { parseBookingHeldEvent } from "@booking-flight-system/contracts";
import type { Logger } from "../observability/logger.js";
import type {
  MessageHandler,
  MessageHandlerResult,
} from "./message-consumer.js";

/** Logs the reference and counts, not passenger names (no PII in logs). */
export function createBookingHeldConsumer(deps: {
  logger: Logger;
}): MessageHandler {
  return async (payload: unknown): Promise<MessageHandlerResult> => {
    const parsed = parseBookingHeldEvent(payload);

    if (!parsed.ok) {
      return { outcome: "rejected", reason: parsed.reason };
    }

    const { event } = parsed;

    deps.logger.info("booking_held_consumed", {
      eventId: event.eventId,
      correlationId: event.correlationId,
      bookingId: event.booking.id,
      reference: event.booking.reference,
      flightId: event.booking.flightId,
      passengerCount: event.booking.passengers.length,
      holdExpiresAt: event.booking.holdExpiresAt,
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}
