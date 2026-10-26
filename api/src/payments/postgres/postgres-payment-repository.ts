import type { DataSource } from "typeorm";

import { parseVndFromDatabase } from "../../money/money.js";
import { resolveEntityManager } from "../../postgres/transaction-context.js";
import type {
  Payment,
  PaymentRepository,
  PaymentStatus,
} from "../payment-repository.js";

type PaymentRow = {
  id: string;
  booking_id: string;
  account_id: string;
  amount_vnd: string;
  status: string;
  provider_reference: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    bookingId: row.booking_id,
    accountId: row.account_id,
    amount: parseVndFromDatabase(row.amount_vnd),
    // CHK_payments_status guarantees the value set.
    status: row.status as PaymentStatus,
    providerReference: row.provider_reference,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Raw SQL, like the idempotency adapter. TypeORM's query() returns the rows
 * for an INSERT … RETURNING, and [rows, rowCount] for an UPDATE.
 *
 * start() names UQ_payments_booking_processing as the arbiter by repeating
 * its predicate: a booking with a PROCESSING payment is the one expected
 * conflict (→ payment-in-progress, no 23505, transaction still usable). Any
 * other conflict — a duplicate id — still raises.
 */
export function createPostgresPaymentRepository(
  dataSource: DataSource,
): PaymentRepository {
  async function transition(
    paymentId: string,
    from: PaymentStatus,
    to: PaymentStatus,
    now: Date,
    set: Readonly<{ providerReference?: string; failureReason?: string }> = {},
  ): Promise<void> {
    const updated = (await resolveEntityManager(dataSource).query(
      `UPDATE "payments"
       SET "status" = $3, "updated_at" = $4,
           "provider_reference" = coalesce($5, "provider_reference"),
           "failure_reason" = coalesce($6, "failure_reason")
       WHERE "id" = $1 AND "status" = $2`,
      [
        paymentId,
        from,
        to,
        now,
        set.providerReference ?? null,
        set.failureReason ?? null,
      ],
    )) as [unknown[], number];

    if (updated[1] !== 1) {
      throw new Error(`Payment ${paymentId} is not ${from}; cannot move it to ${to}`);
    }
  }

  return {
    async start(payment) {
      const inserted = (await resolveEntityManager(dataSource).query(
        `INSERT INTO "payments"
           ("id", "booking_id", "account_id", "amount_vnd", "status", "created_at", "updated_at")
         VALUES ($1, $2, $3, $4, 'PROCESSING', $5, $5)
         ON CONFLICT ("booking_id") WHERE "status" = 'PROCESSING' DO NOTHING
         RETURNING "id"`,
        [
          payment.id,
          payment.bookingId,
          payment.accountId,
          String(payment.amount.amount),
          new Date(payment.createdAt),
        ],
      )) as unknown[];

      return inserted.length === 1
        ? { outcome: "started" }
        : { outcome: "payment-in-progress" };
    },

    async markSucceeded(paymentId, providerReference, now) {
      await transition(paymentId, "PROCESSING", "SUCCEEDED", now, { providerReference });
    },

    async markFailed(paymentId, reason, now) {
      await transition(paymentId, "PROCESSING", "FAILED", now, { failureReason: reason });
    },

    async markRefundPending(paymentId, providerReference, now) {
      await transition(paymentId, "PROCESSING", "REFUND_PENDING", now, { providerReference });
    },

    async markRefunded(paymentId, now) {
      await transition(paymentId, "REFUND_PENDING", "REFUNDED", now);
    },

    async findById(paymentId) {
      const [row] = (await resolveEntityManager(dataSource).query(
        `SELECT "id", "booking_id", "account_id", "amount_vnd", "status",
                "provider_reference", "failure_reason", "created_at", "updated_at"
         FROM "payments" WHERE "id" = $1`,
        [paymentId],
      )) as PaymentRow[];

      return row === undefined ? undefined : mapPayment(row);
    },
  };
}
