const UNIQUE_VIOLATION = "23505";
const EXCLUSION_VIOLATION = "23P01";
const FOREIGN_KEY_VIOLATION = "23503";
const DEADLOCK_DETECTED = "40P01";

function hasSqlState(
  error: unknown,
  code: string,
  constraint: string | undefined,
): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const fields = error as { code?: string; constraint?: string };

  return (
    fields.code === code &&
    (constraint === undefined || fields.constraint === constraint)
  );
}

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
  return hasSqlState(error, UNIQUE_VIOLATION, constraint);
}

/** 23P01: a row conflicts with an EXCLUDE constraint (Day 46). */
export function isExclusionViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return hasSqlState(error, EXCLUSION_VIOLATION, constraint);
}

/** 23503: a referenced row does not exist. */
export function isForeignKeyViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return hasSqlState(error, FOREIGN_KEY_VIOLATION, constraint);
}

/**
 * 40P01: Postgres aborted this transaction to break a lock cycle. Carries no
 * constraint name, so only a caller that knows which wait can deadlock may
 * give it a business meaning.
 */
export function isDeadlockDetected(error: unknown): boolean {
  return hasSqlState(error, DEADLOCK_DETECTED, undefined);
}
