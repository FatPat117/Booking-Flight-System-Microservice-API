import type { BookingHeldEvent } from "@booking-flight-system/contracts";
import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { OutboxRepository } from "../outbox/outbox-repository.js";
import { resolveCorrelationId } from "../outbox/resolve-correlation-id.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor, type ValidationIssue } from "../types.js";
import {
  validateCreateBookingInput,
  type CreateBookingInput,
} from "./booking-validation.js";
import type {
  Booking,
  BookingRepository,
  HoldSeatsResult,
  SeatHoldRequest,
} from "./booking-repository.js";

/** Replaces `booking-created` for new bookings (Decision 11). */
export const BOOKING_HELD_QUEUE = "booking-held";

/** BR-BOOK-04: a hold lasts 15 minutes. */
export const HOLD_DURATION_MS = 15 * 60 * 1000;

/**
 * Draws of a booking reference before giving up. With 32^6 codes a single
 * clash is rare and five in a row means something is broken (a constant
 * generator, an almost full code space) — a system error, not an outcome a
 * client could act on.
 */
export const MAX_REFERENCE_ATTEMPTS = 5;

export class BookingReferenceExhaustedError extends Error {
  constructor(attempts: number) {
    super(`No free booking reference after ${attempts} attempts`);
    this.name = "BookingReferenceExhaustedError";
  }
}

/** Every hold outcome but `held` passes through unchanged (nothing written). */
export type CreateBookingResult =
  | { outcome: "created"; booking: Booking }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | Exclude<HoldSeatsResult, { outcome: "held" }>;

/** The actor becomes the booking's owner (BR-AUTH-01). */
export type CreateBooking = (
  flightId: string,
  input: unknown,
  actor: Actor,
) => Promise<CreateBookingResult>;

function toHoldRequest(input: CreateBookingInput): SeatHoldRequest {
  return input.seatSelection === "auto"
    ? { kind: "auto", count: input.passengers.length }
    : { kind: "chosen", seats: input.passengers.map(({ seat }) => seat) };
}

/**
 * Held seats come back in passenger order — request order when chosen, the
 * lowest free seats in order when auto — so pairing is by index.
 */
function seatPassengers(
  input: CreateBookingInput,
  seats: readonly string[],
): Array<{ name: string; seat: string }> {
  if (seats.length !== input.passengers.length) {
    throw new Error(
      `holdSeats returned ${seats.length} seats for ${input.passengers.length} passengers`,
    );
  }

  return input.passengers.map(({ name }, index) => ({
    name,
    seat: seats[index] as string,
  }));
}

type CreateBookingDependencies = {
  bookingRepository: BookingRepository;
  auditRecorder: AuditRecorder;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  generateId: () => string;
  generateReference: () => string;
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
    generateReference,
    generateAuditId,
    generateOutboxId,
    getRequestId,
    getCurrentTime,
  } = dependencies;

  /**
   * A taken reference leaves the transaction usable (ON CONFLICT, not a
   * caught error), so the seats held before this call stay held while a new
   * reference is drawn.
   */
  async function createWithFreeReference(
    held: Omit<Booking, "reference">,
  ): Promise<Booking> {
    for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      const booking: Booking = { ...held, reference: generateReference() };
      const result = await bookingRepository.create(booking);
      if (result.outcome === "created") {
        return booking;
      }
    }
    throw new BookingReferenceExhaustedError(MAX_REFERENCE_ATTEMPTS);
  }

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

    const request = validation.value;

    return transactionRunner.run(async () => {
      const now = getCurrentTime();
      // The id comes first so the seats can point at the booking before it
      // exists (deferred FK, Decision 10): a refused hold then costs one
      // statement and writes nothing, instead of an insert to undo.
      const bookingId = generateId();
      const holdResult = await bookingRepository.holdSeats(
        flightId,
        bookingId,
        toHoldRequest(request),
        now,
      );

      if (holdResult.outcome !== "held") {
        return holdResult;
      }

      const passengers = seatPassengers(request, holdResult.seats);
      const occurredAt = now.toISOString();
      const holdExpiresAt = new Date(
        now.getTime() + HOLD_DURATION_MS,
      ).toISOString();
      const held: Omit<Booking, "reference"> = {
        id: bookingId,
        flightId,
        ownerAccountId: actor.accountId,
        passengers,
        createdAt: occurredAt,
        status: "HELD",
        holdExpiresAt,
      };

      const booking = await createWithFreeReference(held);

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
        // Who sits where is in the booking itself; the audit row keeps what
        // was decided (no passenger names).
        metadata: {
          flightId: booking.flightId,
          reference: booking.reference,
          passengerCount: passengers.length,
          // Metadata values are flat (AuditMetadata): "12A,12B".
          seats: holdResult.seats.join(","),
          holdExpiresAt,
          correlationId,
        },
      });

      const payload: BookingHeldEvent = {
        eventId,
        correlationId,
        type: "booking.held",
        occurredAt,
        booking: {
          id: booking.id,
          reference: booking.reference,
          flightId: booking.flightId,
          createdAt: booking.createdAt,
          holdExpiresAt,
          passengers,
        },
      };

      await outboxRepository.enqueue({
        id: eventId,
        eventType: BOOKING_HELD_QUEUE,
        payload,
        createdAt: occurredAt,
      });

      return { outcome: "created", booking } as const;
    });
  };
}
