/**
 * SeatPosition value object (domain-model): a row and a letter, rendered
 * "12A". Two positions with equal fields are the same seat.
 */
export type SeatPosition = Readonly<{
  row: number;
  letter: string;
}>;

export const MIN_ROW = 1;
export const MAX_ROW = 99;

/** `A`–`K`, as in domain-model. Lower case is rejected, not normalized. */
const SEAT_LETTER = /^[A-K]$/;
const SEAT_POSITION = /^([1-9][0-9]?)([A-K])$/;

export function isSeatLetter(value: string): boolean {
  return SEAT_LETTER.test(value);
}

export function isSeatRow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_ROW &&
    value <= MAX_ROW
  );
}

export function parseSeatPosition(value: string): SeatPosition | undefined {
  const match = SEAT_POSITION.exec(value);

  if (match === null) {
    return undefined;
  }

  return { row: Number(match[1]), letter: match[2] as string };
}

export function formatSeatPosition(position: SeatPosition): string {
  return `${position.row}${position.letter}`;
}
