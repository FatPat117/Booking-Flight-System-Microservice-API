import type { Logger } from "../observability/logger.js";
import type { ReconcilePayments } from "../payments/reconcile-payments.js";
import type { Job } from "./job-scheduler.js";

/**
 * Runs ReconcilePayments on every tick (Decision 15). Quiet when nothing was
 * due; the use case itself logs each payment that needs a person
 * (`payment_refund_needs_attention`). A warning when a run stopped at its
 * batch limit, because payments then wait at least one more interval.
 */
export function createPaymentReconciliationJob(deps: {
  reconcilePayments: ReconcilePayments;
  logger: Logger;
  intervalMs: number;
}): Job {
  return {
    name: "payment-reconciliation-job",
    intervalMs: deps.intervalMs,
    handler: async () => {
      const { batches, exhausted, ...counts } = await deps.reconcilePayments();

      if (Object.values(counts).some((count) => count > 0)) {
        deps.logger.info("payments_reconciled", { ...counts, batches });
      }

      if (exhausted) {
        deps.logger.warn("payment_reconciliation_backlog", { ...counts, batches });
      }
    },
  };
}
