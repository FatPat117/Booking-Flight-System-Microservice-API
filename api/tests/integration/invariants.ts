import assert from "node:assert/strict";
import type { DataSource } from "typeorm";

/** What the payment provider did, per payment id (the fake gateway's ledger). */
export type ProviderLedger = Readonly<{
  charged: readonly string[];
  refunded: readonly string[];
}>;

type Check = Readonly<{ name: string; sql: string }>;

/**
 * Each query returns the rows that break one invariant; an empty result is
 * a pass. Whole-database: integration tests TRUNCATE before each test, so
 * "everything" is the test's own data.
 */
const CHECKS: readonly Check[] = [
  {
    // HELD ⇔ booking HELD, BOOKED ⇔ booking CONFIRMED (Decision 11/14); an
    // ended booking owns no seat.
    name: "seat status agrees with its booking",
    sql: `SELECT s."row" || s."letter" AS "seat", s."status", b."status" AS "booking"
          FROM "flight_seats" s
          JOIN "bookings" b ON b."id" = s."booking_id"
          WHERE NOT ((s."status" = 'HELD' AND b."status" = 'HELD')
                  OR (s."status" = 'BOOKED' AND b."status" = 'CONFIRMED'))`,
  },
  {
    // Every passenger of a live booking sits on exactly the seat their
    // display copy names, and that seat is the booking's (Decision 11).
    name: "each live passenger owns the seat their copy names",
    sql: `SELECT b."reference", p."position", p."seat_row" || p."seat_letter" AS "copy"
          FROM "booking_passengers" p
          JOIN "bookings" b ON b."id" = p."booking_id"
          LEFT JOIN "flight_seats" s
            ON s."flight_id" = b."flight_id"
           AND s."row" = p."seat_row" AND s."letter" = p."seat_letter"
          WHERE b."status" IN ('HELD', 'CONFIRMED')
            AND (s."booking_id" IS DISTINCT FROM b."id")`,
  },
  {
    // …and owns nothing else: seats owned = passengers, so no booking keeps
    // a seat nobody sits on (a half-done seat change would).
    name: "a booking owns exactly one seat per live passenger",
    sql: `SELECT b."reference", b."status",
                 (SELECT count(*) FROM "flight_seats" s WHERE s."booking_id" = b."id")::int AS "seats",
                 (SELECT count(*) FROM "booking_passengers" p WHERE p."booking_id" = b."id")::int AS "passengers"
          FROM "bookings" b
          WHERE (SELECT count(*) FROM "flight_seats" s WHERE s."booking_id" = b."id")
             <> CASE WHEN b."status" IN ('HELD', 'CONFIRMED')
                     THEN (SELECT count(*) FROM "booking_passengers" p WHERE p."booking_id" = b."id")
                     ELSE 0 END`,
  },
  {
    // The snapshot is per class (Decision 13): a seat change never crosses
    // classes (BR-BOOK-07).
    name: "a live passenger's seat is in their snapshot fare class",
    sql: `SELECT b."reference", p."position", s."fare_class" AS "seat", p."fare_class" AS "snapshot"
          FROM "booking_passengers" p
          JOIN "bookings" b ON b."id" = p."booking_id"
          JOIN "flight_seats" s ON s."booking_id" = b."id"
           AND s."row" = p."seat_row" AND s."letter" = p."seat_letter"
          WHERE b."status" IN ('HELD', 'CONFIRMED') AND s."fare_class" <> p."fare_class"`,
  },
  {
    // BR-PAY-05 and Decision 16: a SUCCEEDED payment means "this booking is
    // paid and stands". Cancelled with its money kept is the Day 50 bug.
    name: "a SUCCEEDED payment belongs to a CONFIRMED booking",
    sql: `SELECT p."id", b."reference", b."status"
          FROM "payments" p JOIN "bookings" b ON b."id" = p."booking_id"
          WHERE p."status" = 'SUCCEEDED' AND b."status" <> 'CONFIRMED'`,
  },
  {
    // A cancelled booking that was charged is being refunded, refunded, or
    // reported for a person — never left SUCCEEDED or forgotten.
    name: "a cancelled booking's charged payment is on its way back",
    sql: `SELECT p."id", b."reference", p."status"
          FROM "payments" p JOIN "bookings" b ON b."id" = p."booking_id"
          WHERE b."status" = 'CANCELLED' AND p."provider_reference" IS NOT NULL
            AND p."status" NOT IN ('REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED')`,
  },
];

/**
 * The global invariants of booking, inventory and money (Day 49C, widened
 * Day 50), as a list of violations — empty when everything holds. A list,
 * not an assertion, so a test can prove each check fires on data broken on
 * purpose: a check that never failed is not yet known to work.
 *
 * With the provider's ledger, money too: each payment id charged and
 * refunded at most once, refunds only of charges, and the money the provider
 * kept — charged minus refunded, less what is still owed back
 * (REFUND_PENDING) or handed to a person (REFUND_FAILED) — equals the total
 * of the bookings that stand paid.
 */
export async function findInvariantViolations(
  dataSource: DataSource,
  ledger?: ProviderLedger,
): Promise<string[]> {
  const violations: string[] = [];

  for (const check of CHECKS) {
    const rows = (await dataSource.query(check.sql)) as unknown[];
    if (rows.length > 0) {
      violations.push(`${check.name}: ${JSON.stringify(rows)}`);
    }
  }

  if (ledger !== undefined) {
    violations.push(...(await findMoneyViolations(dataSource, ledger)));
  }

  return violations;
}

async function findMoneyViolations(
  dataSource: DataSource,
  { charged, refunded }: ProviderLedger,
): Promise<string[]> {
  const violations: string[] = [];
  const twice = (ids: readonly string[]) => ids.filter((id, index) => ids.indexOf(id) !== index);

  if (twice(charged).length > 0) {
    violations.push(`a payment was charged twice: ${twice(charged).join(", ")}`);
  }
  if (twice(refunded).length > 0) {
    violations.push(`a payment was refunded twice: ${twice(refunded).join(", ")}`);
  }
  const neverCharged = refunded.filter((id) => !charged.includes(id));
  if (neverCharged.length > 0) {
    violations.push(`a refund of a payment never charged: ${neverCharged.join(", ")}`);
  }

  const payments = (await dataSource.query(
    `SELECT "id", "status", "amount_vnd"::text AS "amount" FROM "payments"`,
  )) as Array<{ id: string; status: string; amount: string }>;
  const amountOf = new Map(payments.map(({ id, amount }) => [id, BigInt(amount)]));
  const unknown = charged.filter((id) => !amountOf.has(id));
  if (unknown.length > 0) {
    violations.push(`the provider charged an unknown payment: ${unknown.join(", ")}`);
  }

  const sum = (ids: Iterable<string>) =>
    [...ids].reduce((total, id) => total + (amountOf.get(id) ?? 0n), 0n);
  const owedBack = payments
    .filter(({ status }) => status === "REFUND_PENDING" || status === "REFUND_FAILED")
    .map(({ id }) => id)
    .filter((id) => charged.includes(id) && !refunded.includes(id));
  const kept = sum(new Set(charged)) - sum(new Set(refunded)) - sum(owedBack);

  const [{ total }] = (await dataSource.query(
    `SELECT coalesce(sum(p."price_vnd"), 0)::text AS "total"
     FROM "booking_passengers" p
     JOIN "bookings" b ON b."id" = p."booking_id"
     WHERE b."status" = 'CONFIRMED'
       AND EXISTS (SELECT 1 FROM "payments" pay
                   WHERE pay."booking_id" = b."id" AND pay."status" = 'SUCCEEDED')`,
  )) as [{ total: string }];

  if (kept !== BigInt(total)) {
    violations.push(
      `the provider kept ${kept} VND, but the paid CONFIRMED bookings total ${total} VND`,
    );
  }

  return violations;
}

/** Fails with every broken invariant at once, not just the first. */
export async function assertGlobalInvariants(
  dataSource: DataSource,
  ledger?: ProviderLedger,
): Promise<void> {
  assert.deepEqual(await findInvariantViolations(dataSource, ledger), []);
}
