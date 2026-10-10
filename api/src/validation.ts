/**
 * Type guards shared by the hand-written validators (no zod/joi yet).
 * Extracted on Day 45 when airports and aircraft would have been the third
 * and fourth private copies.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
