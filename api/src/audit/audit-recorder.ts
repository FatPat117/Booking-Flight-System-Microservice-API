/**
 * Who performed the action: the Identity account (JWT `sub`), user or admin.
 * Rows written before Day 44 still carry the legacy `admin_api_key/admin`
 * and `passenger/anonymous` actors — the log is append-only, so they stay
 * as written; no code writes them any more.
 *
 * `system` is the process itself acting with no account behind it; `id`
 * names what acted (Day 48B: "booking-hold-expiry"; Day 49B:
 * "payment-refund").
 */
export type AuditActor =
  | {
      type: "account";
      id: string;
    }
  | {
      type: "system";
      id: string;
    };

export type AuditTarget =
  | {
      type: "flight";
      id: string;
    }
  | {
      type: "booking";
      id: string;
    }
  | {
      type: "airport";
      id: string;
    }
  | {
      type: "aircraft";
      id: string;
    }
  | {
      type: "payment";
      id: string;
    };

/**
 * New actions need no migration: audit_logs' CHECK constraints are
 * deliberately loose (Day 38).
 */
export type AuditAction =
  | "FLIGHT_CREATED"
  | "FLIGHT_OPENED"
  | "BOOKING_CREATED"
  | "BOOKING_CANCELLED"
  | "BOOKING_EXPIRED"
  | "BOOKING_CONFIRMED"
  | "PAYMENT_FAILED"
  | "PAYMENT_REFUND_PENDING"
  | "PAYMENT_REFUNDED"
  | "AIRPORT_REGISTERED"
  | "AIRCRAFT_REGISTERED";

export type AuditMetadata = Record<
  string,
  string | number | boolean | null
>;

export type AuditRecordInput = {
  id: string;
  action: AuditAction;
  actor: AuditActor;
  target: AuditTarget;
  requestId?: string;
  occurredAt: string;
  metadata: AuditMetadata;
};

export interface AuditRecorder {
  record(input: AuditRecordInput): Promise<void>;
}
