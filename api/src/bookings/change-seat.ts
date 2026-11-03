import type { SeatPosition } from "../aircraft/seat-position.js";
import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor } from "../types.js";
import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
  ChangeSeatResult,
} from "./booking-repository.js";

/** BookingRepository's refusals, unchanged; success adds the booking as it now reads. */
export type ChangeSeatUseCaseResult =
  | { outcome: "changed" | "unchanged"; booking: Booking }
  | Exclude<ChangeSeatResult, { outcome: "changed" } | { outcome: "unchanged" }>;

export type ChangeSeat = (
  bookingId: string,
  position: number,
  seat: SeatPosition,
  scope: BookingAccessScope,
  actor: Actor,
) => Promise<ChangeSeatUseCaseResult>;

type ChangeSeatDependencies = {
  bookingRepository: BookingRepository;
  auditRecorder: AuditRecorder;
  transactionRunner: TransactionRunner;
  generateAuditId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * US-BOOK-06 (BR-BOOK-07, Decision 16): set one passenger's seat. "Set to
 * X", not "move": a repeat of a change that already happened is
 * `unchanged` — nothing written, no audit — so a retry needs no
 * Idempotency-Key. The swap itself, its locks and its checks are
 * BookingRepository.changeSeat's; this records the audit in the same
 * transaction. No event: nothing consumes seat changes yet.
 */
export function createChangeSeat(dependencies: ChangeSeatDependencies): ChangeSeat {
  const {
    bookingRepository,
    auditRecorder,
    transactionRunner,
    generateAuditId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (bookingId, position, seat, scope, actor) => {
    if (!isUuid(bookingId)) {
      return { outcome: "not-found" };
    }

    const now = getCurrentTime();

    return transactionRunner.run(async () => {
      const result = await bookingRepository.changeSeat(bookingId, position, seat, scope, now);

      if (result.outcome !== "changed" && result.outcome !== "unchanged") {
        return result;
      }

      if (result.outcome === "changed") {
        const requestId = getRequestId();
        await auditRecorder.record({
          id: generateAuditId(),
          action: "BOOKING_SEAT_CHANGED",
          actor: { type: "account", id: actor.accountId },
          target: { type: "booking", id: bookingId },
          ...(requestId === undefined ? {} : { requestId }),
          occurredAt: now.toISOString(),
          metadata: { position, from: result.from, to: result.to },
        });
      }

      const booking = await bookingRepository.findById(bookingId, scope);
      if (booking === undefined) {
        // Just read under a lock in this transaction, in scope: a bug.
        throw new Error(`Booking ${bookingId} could not be read back after a seat change`);
      }
      return { outcome: result.outcome, booking };
    });
  };
}
