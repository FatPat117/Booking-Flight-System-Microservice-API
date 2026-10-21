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
    const { aircraftId, status, fares } = event.flight;

    // Pre-Day-46 messages have neither field, pre-Day-49A ones no fares;
    // they are logged without them.
    deps.logger.info("flight_created_consumed", {
      eventId: event.eventId,
      correlationId: event.correlationId,
      flightId: event.flight.id,
      flightNumber: event.flight.flightNumber,
      origin: event.flight.origin,
      destination: event.flight.destination,
      ...(aircraftId === undefined ? {} : { aircraftId }),
      ...(status === undefined ? {} : { status }),
      ...(fares === undefined
        ? {}
        : {
            fares: Object.entries(fares)
              .map(([fareClass, fare]) => `${fareClass}:${fare.amount} ${fare.currency}`)
              .join(","),
          }),
      occurredAt: event.occurredAt,
    });

    return { outcome: "processed" };
  };
}
