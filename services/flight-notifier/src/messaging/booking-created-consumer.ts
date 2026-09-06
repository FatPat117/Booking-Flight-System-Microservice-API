import { parseBookingCreatedEvent } from "@booking-flight-system/contracts";
import type { Logger } from "../observability/logger.js";
import type {
  MessageHandler,
  MessageHandlerResult,
} from "./message-consumer.js";

export function createBookingCreatedConsumer(deps: {
  logger: Logger;
}): MessageHandler {
  return async (payload: unknown): Promise<MessageHandlerResult> => {
    const parsed = parseBookingCreatedEvent(payload);

    if (!parsed.ok) {
      return { outcome: "rejected", reason: parsed.reason };
    }

    const { event } = parsed;

    deps.logger.info("booking_created_consumed", {
      eventId: event.eventId,
      bookingId: event.booking.id,
      flightId: event.booking.flightId,
      passengerName: event.booking.passengerName,
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}
