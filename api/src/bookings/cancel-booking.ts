import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { ValidationIssue } from "../types.js";
import { validateBookingIdParam } from "./booking-validation.js";
import type { BookingRepository } from "./booking-repository.js";

export const BOOKING_CANCELLED_QUEUE = "booking-cancelled";

export type CancelBookingResult =
  | { outcome: "cancelled"; bookingId: string; flightId: string }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "already-cancelled" }
  | { outcome: "not-found" };

export type CancelBooking = (
  bookingId: string,
) => Promise<CancelBookingResult>;

type CancelBookingDependencies = {
  bookingRepository: BookingRepository;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * Cancel an active booking and release its seat.
 *
 * Seat is released only when cancel() wins the OCC race (first active→cancelled).
 * booking-cancelled stays in outbox only — no contracts entry until a consumer exists.
 */
export function createCancelBooking(
  dependencies: CancelBookingDependencies,
): CancelBooking {
  const {
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId,
    generateOutboxId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (bookingIdParam: string): Promise<CancelBookingResult> => {
    const bookingIdValidation = validateBookingIdParam(bookingIdParam);

    if (!bookingIdValidation.success) {
      return {
        outcome: "validation_failed",
        issues: bookingIdValidation.issues,
      };
    }

    const bookingId = bookingIdValidation.value;

    return transactionRunner.run(async () => {
      const cancelResult = bookingRepository.cancel(bookingId);

      if (cancelResult.outcome === "not-found") {
        return { outcome: "not-found" } as const;
      }

      if (cancelResult.outcome === "already-cancelled") {
        return { outcome: "already-cancelled" } as const;
      }

      const { flightId } = cancelResult;
      bookingRepository.releaseSeat(flightId);

      const occurredAt = getCurrentTime().toISOString();
      const requestId = getRequestId();
      const eventId = generateOutboxId();
      const correlationId = resolveCorrelationId(requestId, eventId);

      await auditRecorder.record({
        id: generateAuditId(),
        action: "BOOKING_CANCELLED",
        actor: {
          type: "passenger",
          id: "anonymous",
        },
        target: {
          type: "booking",
          id: bookingId,
        },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt,
        metadata: {
          flightId,
          correlationId,
        },
      });

      // Intentionally not in packages/contracts — no consumer yet (Day 27 rule).
      await outboxRepository.enqueue({
        id: eventId,
        eventType: BOOKING_CANCELLED_QUEUE,
        payload: {
          eventId,
          correlationId,
          type: "booking.cancelled",
          occurredAt,
          booking: {
            id: bookingId,
            flightId,
          },
        },
        createdAt: occurredAt,
      });

      return { outcome: "cancelled", bookingId, flightId } as const;
    });
  };
}
