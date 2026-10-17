import type { BookingExpiredEvent } from "@booking-flight-system/contracts";
import type { AuditActor, AuditRecorder } from "../audit/audit-recorder.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { BookingRepository } from "./booking-repository.js";

export const BOOKING_EXPIRED_QUEUE = "booking-expired";

/** Who expires a hold: no account, the job itself (Decision 12). */
export const HOLD_EXPIRY_ACTOR: AuditActor = {
  type: "system",
  id: "booking-hold-expiry",
};

/**
 * - expired: bookings moved HELD → EXPIRED in this run.
 * - batches: transactions run, including a final short or empty one.
 * - exhausted: stopped at `maxBatches` with the last batch full, so more
 *   holds may still be due; the next run continues.
 */
export type ExpireHoldsResult = Readonly<{
  expired: number;
  batches: number;
  exhausted: boolean;
}>;

export type ExpireHolds = () => Promise<ExpireHoldsResult>;

type ExpireHoldsDependencies = {
  bookingRepository: BookingRepository;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getCurrentTime: () => Date;
  batchSize: number;
  maxBatches: number;
};

/**
 * One run of the expiry job (US-SEAT-02, BR-BOOK-04, Decision 12).
 *
 * `now` is read once per run: every batch of the run uses the same boundary
 * (BR-BOOK-10), so a hold that lapses while the run is going waits for the
 * next run instead of joining a later batch of this one.
 *
 * Each batch is its own transaction — the seats, the EXPIRED status, one
 * audit entry and one outbox event per booking commit together or not at
 * all. A failing batch throws (the scheduler logs `job_failed`); batches
 * committed before it stay committed, and the next run retries the rest.
 */
export function createExpireHolds(
  dependencies: ExpireHoldsDependencies,
): ExpireHolds {
  const {
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId,
    generateOutboxId,
    getCurrentTime,
    batchSize,
    maxBatches,
  } = dependencies;

  async function expireBatch(now: Date): Promise<number> {
    return transactionRunner.run(async () => {
      const holds = await bookingRepository.expireDueHolds(now, batchSize);
      const occurredAt = now.toISOString();

      for (const hold of holds) {
        const eventId = generateOutboxId();
        const correlationId = resolveCorrelationId(undefined, eventId);

        await auditRecorder.record({
          id: generateAuditId(),
          action: "BOOKING_EXPIRED",
          actor: HOLD_EXPIRY_ACTOR,
          target: { type: "booking", id: hold.bookingId },
          occurredAt,
          metadata: {
            flightId: hold.flightId,
            reference: hold.reference,
            // Flat metadata, as BOOKING_CREATED writes it: "12A,12B".
            seats: hold.seats.join(","),
            holdExpiresAt: hold.holdExpiresAt,
            correlationId,
          },
        });

        const payload: BookingExpiredEvent = {
          eventId,
          correlationId,
          type: "booking.expired",
          occurredAt,
          booking: {
            id: hold.bookingId,
            reference: hold.reference,
            flightId: hold.flightId,
            holdExpiresAt: hold.holdExpiresAt,
            seats: [...hold.seats],
          },
        };

        await outboxRepository.enqueue({
          id: eventId,
          eventType: BOOKING_EXPIRED_QUEUE,
          payload,
          createdAt: occurredAt,
        });
      }

      return holds.length;
    });
  }

  return async () => {
    const now = getCurrentTime();
    let expired = 0;

    for (let batches = 1; batches <= maxBatches; batches += 1) {
      const count = await expireBatch(now);
      expired += count;

      if (count < batchSize) {
        return { expired, batches, exhausted: false };
      }
    }

    return { expired, batches: maxBatches, exhausted: true };
  };
}
