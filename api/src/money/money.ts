/**
 * Money value object (domain-model, Decision 13). `amount` is an integer in
 * the currency's smallest unit; for VND that is whole đồng, so 1 500 000 is
 * 1.5 million đồng — never multiplied by 100. Two values with equal fields
 * are the same amount.
 */
export const CURRENCIES = ["VND"] as const;
export type Currency = (typeof CURRENCIES)[number];

export type Money = Readonly<{
  amount: number;
  currency: Currency;
}>;

/** Whole đồng, ≥ 0, and exact as a JS number (≤ 2^53 − 1). */
export function isVndAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Throws: an invalid amount here is a programmer error, not user input. */
export function vnd(amount: number): Money {
  if (!isVndAmount(amount)) {
    throw new RangeError(`Invalid VND amount: ${amount}`);
  }

  return { amount, currency: "VND" };
}

export function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) {
    throw new TypeError(
      `Cannot add ${left.currency} and ${right.currency}`,
    );
  }

  const amount = left.amount + right.amount;

  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Money sum is out of the safe integer range: ${amount}`);
  }

  return { amount, currency: left.currency };
}

/** An empty list is zero, so a total never needs a special case. */
export function sumMoney(items: readonly Money[], currency: Currency): Money {
  return items.reduce(addMoney, { amount: 0, currency });
}

const DATABASE_INTEGER = /^(0|[1-9][0-9]*)$/;

/**
 * `pg` returns `bigint` columns as strings. A value that is not a whole,
 * exactly representable number of đồng cannot come from a real fare, so it
 * throws instead of becoming a rounded price.
 */
export function parseVndFromDatabase(value: string | number): Money {
  const amount =
    typeof value === "number"
      ? value
      : DATABASE_INTEGER.test(value)
        ? Number(value)
        : Number.NaN;

  if (!isVndAmount(amount)) {
    throw new RangeError(`Database amount is not a safe VND integer: ${value}`);
  }

  return { amount, currency: "VND" };
}
