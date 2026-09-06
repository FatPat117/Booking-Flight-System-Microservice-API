/**
 * correlationId = requestId of the HTTP request that produced this event.
 * When there is no request context (e.g. a future internal job), the event
 * correlates with itself — use its own eventId.
 */
export function resolveCorrelationId(
  requestId: string | undefined,
  eventId: string,
): string {
  return requestId ?? eventId;
}
