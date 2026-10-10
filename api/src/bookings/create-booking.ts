import type { BookingCreatedEvent } from "@booking-flight-system/contracts";
import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor, type ValidationIssue } from "../types.js";
import { validateCreateBookingInput } from "./booking-validation.js";
import type { Booking, BookingRepository } from "./booking-repository.js";

export const BOOKING_CREATED_QUEUE = "booking-created";

export type CreateBookingResult =
  | { outcome: "created"; booking: Booking }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "sold-out" }
  | { outcome: "sales-closed" }
  | { outcome: "flight-not-found" };

/** The actor becomes the booking's owner (BR-AUTH-01). */
export type CreateBooking = (
  flightId: string,
  input: unknown,
  actor: Actor,
) => Promise<CreateBookingResult>;

type CreateBookingDependencies = {
  bookingRepository: BookingRepository;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  generateId: () => string;
  generateAuditId: () => string;
  generateOutboxId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

export function createCreateBooking(
  dependencies: CreateBookingDependencies,
): CreateBooking {
  const {
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId,
    generateAuditId,
    generateOutboxId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  return async (
    flightId: string,
    input: unknown,
    actor: Actor,
  ): Promise<CreateBookingResult> => {
    if (!isUuid(flightId)) {
      return { outcome: "flight-not-found" };
    }

    const validation = validateCreateBookingInput(input);

    if (!validation.success) {
      return {
        outcome: "validation_failed",
        issues: validation.issues,
      };
    }

    const { passengerName } = validation.value;

    return transactionRunner.run(async () => {
      const now = getCurrentTime();
      const reserveResult = await bookingRepository.reserveSeat(flightId, now);

      // flight-not-found / sold-out / sales-closed pass through unchanged.
      if (reserveResult.outcome !== "reserved") {
        return reserveResult;
      }

      const occurredAt = now.toISOString();
      const booking: Booking = {
        id: generateId(),
        flightId,
        ownerAccountId: actor.accountId,
        passengerName,
        createdAt: occurredAt,
        status: "active",
      };

      await bookingRepository.create(booking);

      const requestId = getRequestId();
      const eventId = generateOutboxId();
      const correlationId = resolveCorrelationId(requestId, eventId);

      await auditRecorder.record({
        id: generateAuditId(),
        action: "BOOKING_CREATED",
        actor: {
          type: "account",
          id: actor.accountId,
        },
        target: {
          type: "booking",
          id: booking.id,
        },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt,
        metadata: {
          flightId: booking.flightId,
          passengerName: booking.passengerName,
          correlationId,
        },
      });

      const payload: BookingCreatedEvent = {
        eventId,
        correlationId,
        type: "booking.created",
        occurredAt,
        booking: {
          id: booking.id,
          flightId: booking.flightId,
          passengerName: booking.passengerName,
          createdAt: booking.createdAt,
        },
      };

      await outboxRepository.enqueue({
        id: eventId,
        eventType: BOOKING_CREATED_QUEUE,
        payload,
        createdAt: occurredAt,
      });

      return { outcome: "created", booking } as const;
    });
  };
}
