import type { AuditActor } from "../audit/audit-recorder.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { BookingRepository } from "./booking-repository.js";
import type { CancelBookingInTransaction } from "./cancel-booking.js";

/** Who cancels a booking when its flight is cancelled: the cascade job. */
export const FLIGHT_CANCELLATION_ACTOR: AuditActor = {
  type: "system",
  id: "flight-cancellation",
};

/**
 * - cancelled: bookings moved to CANCELLED (reason AIRLINE) in this run.
 * - refundsStarted: of those, the paid ones whose payment is now
 *   REFUND_PENDING (the reconciliation job refunds them).
 * - exhausted: stopped at `maxPerRun`, so more may be left; the next run
 *   continues.
 */
export type CascadeFlightCancellationsResult = Readonly<{
  cancelled: number;
  refundsStarted: number;
  exhausted: boolean;
}>;

export type CascadeFlightCancellations = () => Promise<CascadeFlightCancellationsResult>;

type CascadeFlightCancellationsDependencies = {
  bookingRepository: BookingRepository;
  transactionRunner: TransactionRunner;
  cancelBookingInTransaction: CancelBookingInTransaction;
  getCurrentTime: () => Date;
  maxPerRun: number;
};

/**
 * One run of the flight cancellation cascade (US-OPS-01, BR-FLT-07,
 * Decision 18). State-driven: the work is "a live booking of a CANCELLED
 * flight", read from the database each time, so the job remembers nothing
 * and a run after a crash simply continues where the bookings say.
 *
 * One booking per transaction: claim it (SKIP LOCKED, so a second instance
 * or a customer cancelling it right now is skipped, not waited for), then
 * the cancel core with reason AIRLINE — seats released in (row, letter)
 * order, payment to REFUND_PENDING, audit, event — and commit. A
 * transaction locks one booking and its seats for milliseconds, never a
 * whole flight. No gateway call (ADR-009).
 *
 * `now` is read once per run, like the expiry job: a hold lapsing during the
 * run is left to the expiry job, never cancelled with a stale instant.
 */
export function createCascadeFlightCancellations(
  dependencies: CascadeFlightCancellationsDependencies,
): CascadeFlightCancellations {
  const {
    bookingRepository,
    transactionRunner,
    cancelBookingInTransaction,
    getCurrentTime,
    maxPerRun,
  } = dependencies;

  return async () => {
    const now = getCurrentTime();
    let cancelled = 0;
    let refundsStarted = 0;

    while (cancelled < maxPerRun) {
      const result = await transactionRunner.run(async () => {
        const bookingId = await bookingRepository.claimLiveBookingOfCancelledFlight(now);
        if (bookingId === undefined) {
          return undefined;
        }

        const outcome = await cancelBookingInTransaction({
          bookingId,
          scope: { kind: "admin" },
          reason: "AIRLINE",
          auditActor: FLIGHT_CANCELLATION_ACTOR,
          now,
        });
        // Claimed under the AIRLINE cancel's own condition and locked: any
        // other answer means the two conditions disagree — a bug.
        if (outcome.outcome !== "cancelled") {
          throw new Error(
            `Claimed booking ${bookingId} was not cancelled: ${outcome.outcome}`,
          );
        }
        return outcome;
      });

      if (result === undefined) {
        return { cancelled, refundsStarted, exhausted: false };
      }
      cancelled += 1;
      if (result.refund !== null) {
        refundsStarted += 1;
      }
    }

    return { cancelled, refundsStarted, exhausted: true };
  };
}
