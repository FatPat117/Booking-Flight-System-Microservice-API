import { randomInt as cryptoRandomInt } from "node:crypto";

/**
 * BookingReference (domain-model value objects, BR-BOOK-05): 6 characters
 * people can read aloud — no 0/O and no 1/I. 32 characters, so 32^6 ≈ 1.07
 * billion references.
 *
 * Random, not sequential: a sequence would reveal how many bookings exist and
 * make the next one guessable. Random is still not secret — a lookup by
 * reference is owner-scoped (BR-AUTH-02), never "whoever knows the code".
 */
export const BOOKING_REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const BOOKING_REFERENCE_LENGTH = 6;

/** Mirrors CHK_bookings_reference_format (AddBookingReference migration). */
const BOOKING_REFERENCE = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * `randomInt(max)` returns an integer in [0, max). Defaults to
 * crypto.randomInt — Math.random is not a cryptographically strong source and
 * its output can be predicted. Injected so tests can force a given code.
 */
export function generateBookingReference(
  randomInt: (max: number) => number = cryptoRandomInt,
): string {
  let reference = "";
  for (let i = 0; i < BOOKING_REFERENCE_LENGTH; i += 1) {
    reference += BOOKING_REFERENCE_ALPHABET[randomInt(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return reference;
}

/** For the lookup route: anything else cannot be a reference (→ 404). */
export function isBookingReference(value: unknown): value is string {
  return typeof value === "string" && BOOKING_REFERENCE.test(value);
}
