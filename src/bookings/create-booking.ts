import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import type { ValidationIssue } from "../types.js";
import {
  validateCreateBookingInput,
  validateFlightIdParam,
} from "./booking-validation.js";
import type { Booking, BookingRepository } from "./booking-repository.js";

export const BOOKING_CREATED_QUEUE = "booking-created";

export type CreateBookingResult =
  | { outcome: "created"; booking: Booking }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "sold-out" }
  | { outcome: "flight-not-found" };

export type CreateBooking = (
  flightId: string,
  input: unknown,
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
    flightIdParam: string,
    input: unknown,
  ): Promise<CreateBookingResult> => {
    const flightIdValidation = validateFlightIdParam(flightIdParam);

    if (!flightIdValidation.success) {
      return {
        outcome: "validation_failed",
        issues: flightIdValidation.issues,
      };
    }

    const validation = validateCreateBookingInput(input);

    if (!validation.success) {
      return {
        outcome: "validation_failed",
        issues: validation.issues,
      };
    }

    const flightId = flightIdValidation.value;
    const { passengerName } = validation.value;

    return transactionRunner.run(() => {
      const reserveResult = bookingRepository.reserveSeat(flightId);

      if (reserveResult.outcome === "flight-not-found") {
        return { outcome: "flight-not-found" } as const;
      }

      if (reserveResult.outcome === "sold-out") {
        return { outcome: "sold-out" } as const;
      }

      const occurredAt = getCurrentTime().toISOString();
      const booking: Booking = {
        id: generateId(),
        flightId,
        passengerName,
        createdAt: occurredAt,
      };

      bookingRepository.create(booking);

      const requestId = getRequestId();

      auditRecorder.record({
        id: generateAuditId(),
        action: "BOOKING_CREATED",
        actor: {
          type: "passenger",
          id: "anonymous",
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
        },
      });

      const eventId = generateOutboxId();

      outboxRepository.enqueue({
        id: eventId,
        eventType: BOOKING_CREATED_QUEUE,
        payload: {
          eventId,
          type: "booking.created",
          occurredAt,
          booking,
        },
        createdAt: occurredAt,
      });

      return { outcome: "created", booking } as const;
    });
  };
}
