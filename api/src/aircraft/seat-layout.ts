import type { ValidationIssue, ValidationResult } from "../types.js";
import { isNonEmptyString, isPlainObject } from "../validation.js";
import {
  formatSeatPosition,
  isSeatLetter,
  isSeatRow,
  MAX_ROW,
  type SeatPosition,
} from "./seat-position.js";

export const FARE_CLASSES = ["ECONOMY", "BUSINESS"] as const;
export type FareClass = (typeof FARE_CLASSES)[number];

/** One seat of an aircraft's layout. No status: that belongs to FlightSeat. */
export type LayoutSeat = Readonly<{
  position: SeatPosition;
  fareClass: FareClass;
}>;

/**
 * BR-REF-06. maxSeats: the A380 is certified for 853 passengers, so 900
 * fits any real aircraft. Rows (≤ 99) and letters (≤ 10) are bounded per
 * cabin too, so no single field can ask for an unbounded expansion.
 */
export const SEAT_LAYOUT_LIMITS = {
  maxCabins: 10,
  maxLettersPerRow: 10,
  maxSeats: 900,
} as const;

type Cabin = {
  fareClass: FareClass;
  fromRow: number;
  toRow: number;
  letters: string[];
};

function isFareClass(value: unknown): value is FareClass {
  return FARE_CLASSES.some((fareClass) => fareClass === value);
}

function parseCabin(
  raw: unknown,
  field: string,
  issues: ValidationIssue[],
): Cabin | undefined {
  if (!isPlainObject(raw)) {
    issues.push({
      field,
      code: "INVALID_CABIN",
      message: `${field} must be an object`,
    });
    return undefined;
  }

  const issueCountBefore = issues.length;

  if (!isFareClass(raw.fareClass)) {
    issues.push({
      field: `${field}.fareClass`,
      code: "INVALID_FARE_CLASS",
      message: `fareClass must be one of ${FARE_CLASSES.join(", ")}`,
    });
  }

  for (const key of ["fromRow", "toRow"] as const) {
    if (!isSeatRow(raw[key])) {
      issues.push({
        field: `${field}.${key}`,
        code: "INVALID_ROW",
        message: `${key} must be an integer from 1 to ${MAX_ROW}`,
      });
    }
  }

  if (
    isSeatRow(raw.fromRow) &&
    isSeatRow(raw.toRow) &&
    raw.fromRow > raw.toRow
  ) {
    issues.push({
      field: `${field}.toRow`,
      code: "INVALID_ROW_RANGE",
      message: "toRow must not be lower than fromRow",
    });
  }

  const letters = parseSeatLetters(
    raw.seatLetters,
    `${field}.seatLetters`,
    issues,
  );

  if (issues.length > issueCountBefore || letters === undefined) {
    return undefined;
  }

  return {
    fareClass: raw.fareClass as FareClass,
    fromRow: raw.fromRow as number,
    toRow: raw.toRow as number,
    letters,
  };
}

function parseSeatLetters(
  raw: unknown,
  field: string,
  issues: ValidationIssue[],
): string[] | undefined {
  // Length is checked before the string is split, so a huge string is
  // rejected without being walked.
  if (
    !isNonEmptyString(raw) ||
    raw.length > SEAT_LAYOUT_LIMITS.maxLettersPerRow
  ) {
    issues.push({
      field,
      code: "INVALID_SEAT_LETTERS",
      message: `seatLetters must be 1 to ${SEAT_LAYOUT_LIMITS.maxLettersPerRow} letters from A to K`,
    });
    return undefined;
  }

  const letters = [...raw];
  const invalid = letters.filter((letter) => !isSeatLetter(letter));

  if (invalid.length > 0) {
    issues.push({
      field,
      code: "INVALID_SEAT_LETTERS",
      message: `seatLetters may only contain A to K (got ${invalid.join(", ")})`,
    });
    return undefined;
  }

  const repeated = letters.filter(
    (letter, index) => letters.indexOf(letter) !== index,
  );

  if (repeated.length > 0) {
    issues.push({
      field,
      code: "DUPLICATE_SEAT_LETTER",
      message: `seatLetters repeats ${[...new Set(repeated)].join(", ")}`,
    });
    return undefined;
  }

  return letters;
}

export function countSeatsByFareClass(
  seats: readonly LayoutSeat[],
): Record<FareClass, number> {
  const counts: Record<FareClass, number> = { ECONOMY: 0, BUSINESS: 0 };

  for (const seat of seats) {
    counts[seat.fareClass] += 1;
  }

  return counts;
}

function seatCount(cabin: Cabin): number {
  return (cabin.toRow - cabin.fromRow + 1) * cabin.letters.length;
}

/**
 * BR-REF-06: no row in two cabins. When the overlapping rows also share a
 * letter, the message names the duplicated position (US-REF-02: "naming
 * 12A"), which would otherwise be BR-REF-03's duplicate seat.
 */
function findOverlaps(cabins: Cabin[], field: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  cabins.forEach((cabin, index) => {
    for (let earlier = 0; earlier < index; earlier += 1) {
      const other = cabins[earlier] as Cabin;
      const firstRow = Math.max(cabin.fromRow, other.fromRow);
      const lastRow = Math.min(cabin.toRow, other.toRow);

      if (firstRow > lastRow) {
        continue;
      }

      const sharedLetter = cabin.letters.find((letter) =>
        other.letters.includes(letter),
      );
      const rows =
        firstRow === lastRow
          ? `row ${firstRow} also belongs`
          : `rows ${firstRow}–${lastRow} also belong`;
      const seat =
        sharedLetter === undefined
          ? ""
          : ` (seat ${formatSeatPosition({ row: firstRow, letter: sharedLetter })} is listed twice)`;

      issues.push({
        field: `${field}.cabins[${index}]`,
        code: "CABIN_ROWS_OVERLAP",
        message: `${rows} to cabins[${earlier}]${seat}`,
      });
    }
  });

  return issues;
}

/**
 * Pure: compact cabin description → one LayoutSeat per position, or every
 * problem found. Expansion happens last, only once all limits hold, and the
 * seat total is computed from the input numbers — never by expanding first
 * (input amplification: a 40-byte request must not allocate a million seats).
 *
 * `field` prefixes issue paths so callers can nest the layout in a body.
 */
export function expandSeatLayout(
  input: unknown,
  field = "seatLayout",
): ValidationResult<LayoutSeat[]> {
  if (!isPlainObject(input) || !Array.isArray(input.cabins)) {
    return {
      success: false,
      issues: [
        {
          field,
          code: "INVALID_SEAT_LAYOUT",
          message: `${field} must be an object with a cabins array`,
        },
      ],
    };
  }

  const rawCabins: unknown[] = input.cabins;

  if (
    rawCabins.length === 0 ||
    rawCabins.length > SEAT_LAYOUT_LIMITS.maxCabins
  ) {
    return {
      success: false,
      issues: [
        {
          field: `${field}.cabins`,
          code: "INVALID_CABIN_COUNT",
          message: `cabins must contain 1 to ${SEAT_LAYOUT_LIMITS.maxCabins} cabins`,
        },
      ],
    };
  }

  const issues: ValidationIssue[] = [];
  const cabins = rawCabins.map((raw, index) =>
    parseCabin(raw, `${field}.cabins[${index}]`, issues),
  );

  if (issues.length > 0) {
    return { success: false, issues };
  }

  const validCabins = cabins as Cabin[];
  issues.push(...findOverlaps(validCabins, field));

  const totalSeats = validCabins.reduce(
    (total, cabin) => total + seatCount(cabin),
    0,
  );

  if (totalSeats > SEAT_LAYOUT_LIMITS.maxSeats) {
    issues.push({
      field: `${field}.cabins`,
      code: "TOO_MANY_SEATS",
      message: `the layout has ${totalSeats} seats; the maximum is ${SEAT_LAYOUT_LIMITS.maxSeats}`,
    });
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  const seats: LayoutSeat[] = [];

  for (const cabin of validCabins) {
    for (let row = cabin.fromRow; row <= cabin.toRow; row += 1) {
      for (const letter of cabin.letters) {
        seats.push({ position: { row, letter }, fareClass: cabin.fareClass });
      }
    }
  }

  return { success: true, value: seats };
}
