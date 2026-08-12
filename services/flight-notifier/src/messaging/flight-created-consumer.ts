import type { Logger } from "../observability/logger.js";
import { parseFlightCreatedEvent } from "./flight-created-event.js";
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

    deps.logger.info("flight_created_consumed", {
      flightId: event.flight.id,
      flightNumber: event.flight.flightNumber,
      origin: event.flight.origin,
      destination: event.flight.destination,
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}
