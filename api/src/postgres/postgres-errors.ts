const UNIQUE_VIOLATION = "23505";

/**
 * TypeORM's QueryFailedError copies the pg driver's fields (`code`,
 * `constraint`) onto itself. Pass `constraint` when a table has more than one
 * unique index and only one of them is a business outcome — e.g. a taken
 * airport code is `duplicate`, a colliding primary key is a bug that must
 * still throw.
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const fields = error as { code?: string; constraint?: string };

  return (
    fields.code === UNIQUE_VIOLATION &&
    (constraint === undefined || fields.constraint === constraint)
  );
}
