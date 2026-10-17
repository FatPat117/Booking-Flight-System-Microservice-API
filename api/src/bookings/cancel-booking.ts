import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor } from "../types.js";
import type {
  BookingAccessScope,
  BookingRepository,
} from "./booking-repository.js";

export const BOOKING_CANCELLED_QUEUE = "booking-cancelled";

export type CancelBookingResult =
  | { outcome: "cancelled"; bookingId: string; flightId: string }
  | { outcome: "already-cancelled" }
  | { outcome: "expired" }
  | { outcome: "not-found" };

/**
 * `scope` decides which bookings the caller can reach (out of scope →
 * not-found, BR-AUTH-02); `actor` is who gets recorded in the audit log.
 */
export type CancelBooking = (
  bookingId: string,
  scope: BookingAccessScope,
  actor: Actor,
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
 * Cancel a HELD or CONFIRMED booking and release all its seats. A HELD one
 * is limited only by its own hold: once lapsed (BR-BOOK-10) it is expired,
 * not cancelled — `expired`, nothing written, the expiry job ends it
 * (Decision 12). BR-BOOK-06 covers CONFIRMED only and arrives with step 7.
 *
 * `now` is read once and used for the decision and the audit/event time.
 * BookingRepository.cancel() checks the deadline and releases the seats in
 * the same statement, only when it wins the OCC race.
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

  return async (
    bookingId: string,
    scope: BookingAccessScope,
    actor: Actor,
  ): Promise<CancelBookingResult> => {
    if (!isUuid(bookingId)) {
      return { outcome: "not-found" };
    }

    const now = getCurrentTime();

    return transactionRunner.run(async () => {
      const cancelResult = await bookingRepository.cancel(bookingId, scope, now);

      if (cancelResult.outcome !== "cancelled") {
        return cancelResult;
      }

      const { flightId } = cancelResult;

      const occurredAt = now.toISOString();
      const requestId = getRequestId();
      const eventId = generateOutboxId();
      const correlationId = resolveCorrelationId(requestId, eventId);

      await auditRecorder.record({
        id: generateAuditId(),
        action: "BOOKING_CANCELLED",
        actor: {
          type: "account",
          id: actor.accountId,
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
