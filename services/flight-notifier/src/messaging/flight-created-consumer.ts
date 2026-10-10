import type { Logger } from "../observability/logger.js";
import { parseFlightCreatedEvent } from "@booking-flight-system/contracts";
import type {
  MessageHandler,
  MessageHandlerResult,
} from "./message-consumer.js";

export function createFlightCreatedConsumer(deps: {
  logger: Logger;
}): MessageHandler {
  return async (payload: unknown): Promise<MessageHandlerResult> => {
    const parsed = parseFlightCreatedEvent(payload);

    if (!parsed.ok) {
      return { outcome: "rejected", reason: parsed.reason };
    }

    const { event } = parsed;
    const { aircraftId, status } = event.flight;

    // Pre-Day-46 messages have neither field; they are logged without them.
    deps.logger.info("flight_created_consumed", {
      eventId: event.eventId,
      correlationId: event.correlationId,
      flightId: event.flight.id,
      flightNumber: event.flight.flightNumber,
      origin: event.flight.origin,
      destination: event.flight.destination,
      ...(aircraftId === undefined ? {} : { aircraftId }),
      ...(status === undefined ? {} : { status }),
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}
