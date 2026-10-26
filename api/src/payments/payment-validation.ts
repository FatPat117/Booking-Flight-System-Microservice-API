import { CURRENCIES, type Money } from "../money/money.js";
import type { ValidationIssue, ValidationResult } from "../types.js";
import { isNonEmptyString, isPlainObject } from "../validation.js";

export type PaymentInput = Readonly<{
  paymentMethodToken: string;
  /** What the customer saw and agrees to pay; must equal the total (BR-PAY-03). */
  amount: Money;
}>;

/** Decision 14: 1–255 visible ASCII characters (no spaces, no control characters). */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

function isCurrency(value: unknown): value is Money["currency"] {
  return CURRENCIES.some((currency) => currency === value);
}

/**
 * The body as it is fingerprinted: only the fields the payment uses, in a
 * fixed shape, so two bodies that mean the same payment have the same
 * fingerprint (an extra field the server ignores does not change it).
 */
export function validatePaymentInput(
  input: unknown,
): ValidationResult<PaymentInput> {
  if (!isPlainObject(input)) {
    return {
      success: false,
      issues: [
        {
          field: "body",
          code: "INVALID_BODY",
          message: "Request body must be a JSON object",
        },
      ],
    };
  }

  const issues: ValidationIssue[] = [];

  if (!isNonEmptyString(input.paymentMethodToken)) {
    issues.push({
      field: "paymentMethodToken",
      code: "REQUIRED",
      message: "paymentMethodToken must be a non-empty string",
    });
  }

  const amount = input.amount;
  if (!isPlainObject(amount)) {
    issues.push({
      field: "amount",
      code: "REQUIRED",
      message: "amount must be an object { amount, currency }",
    });
  } else {
    if (
      typeof amount.amount !== "number" ||
      !Number.isSafeInteger(amount.amount) ||
      amount.amount <= 0
    ) {
      issues.push({
        field: "amount.amount",
        code: "INVALID_AMOUNT",
        message: "amount.amount must be a positive whole number of đồng",
      });
    }
    if (!isCurrency(amount.currency)) {
      issues.push({
        field: "amount.currency",
        code: "UNSUPPORTED_CURRENCY",
        message: `amount.currency must be one of ${CURRENCIES.join(", ")}`,
      });
    }
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  const money = amount as { amount: number; currency: Money["currency"] };
  return {
    success: true,
    value: {
      paymentMethodToken: (input.paymentMethodToken as string).trim(),
      amount: { amount: money.amount, currency: money.currency },
    },
  };
}
