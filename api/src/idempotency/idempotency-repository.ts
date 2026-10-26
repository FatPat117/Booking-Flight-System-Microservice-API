/**
 * HTTP Idempotency-Key records (Day 49B, domain-model Decision 14).
 *
 * A key belongs to one account and one operation: two accounts sending the
 * same key string never see each other's record (Day 44 — every lookup
 * carries the owner).
 *
 * Must not know: HTTP, Express, payments' rules, the database driver.
 */
export const PAY_BOOKING_OPERATION = "pay-booking";

export type IdempotencyOperation = typeof PAY_BOOKING_OPERATION;

export type IdempotencyScope = Readonly<{
  accountId: string;
  operation: IdempotencyOperation;
}>;

/** The final response, replayed byte-for-byte to a repeated request. */
export type StoredResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export type ClaimResult =
  /** This request owns the key; it must later complete or release it. */
  | Readonly<{ outcome: "claimed" }>
  /** Another request with this key has not finished. */
  | Readonly<{ outcome: "in-progress"; fingerprint: string }>
  | Readonly<{
      outcome: "completed";
      fingerprint: string;
      response: StoredResponse;
    }>;

export type IdempotencyRepository = Readonly<{
  /**
   * Take the key, or report who has it. `fingerprint` is stored only by the
   * claim that wins; the other outcomes return the stored one, so the caller
   * can tell a repeat (same fingerprint) from a reused key (BR-PAY-02).
   * Inside a transaction, a concurrent claim of the same key waits until the
   * first one's transaction ends.
   */
  claim(
    scope: IdempotencyScope,
    key: string,
    fingerprint: string,
    now: Date,
  ): Promise<ClaimResult>;

  /**
   * Link the key to the payment it started, in the same transaction that
   * created the payment, so reconciliation (49C) can find the key of a
   * payment left PROCESSING. Throws if the key is not claimed.
   */
  attachPayment(
    scope: IdempotencyScope,
    key: string,
    paymentId: string,
  ): Promise<void>;

  /**
   * Store the final response. Call it in the transaction that writes the
   * business outcome, so a completed key never disagrees with the data.
   * Throws if the key is not in progress (a programmer error).
   */
  complete(
    scope: IdempotencyScope,
    key: string,
    response: StoredResponse,
    now: Date,
  ): Promise<void>;

  /**
   * Give the key up so the client can retry with it: for outcomes that are
   * not stored (amount mismatch, another payment in progress). A completed
   * key is left untouched.
   */
  release(scope: IdempotencyScope, key: string): Promise<void>;
}>;
