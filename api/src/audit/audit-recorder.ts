/**
 * Who performed the action: the Identity account (JWT `sub`), user or admin.
 * Rows written before Day 44 still carry the legacy `admin_api_key/admin`
 * and `passenger/anonymous` actors — the log is append-only, so they stay
 * as written; no code writes them any more.
 */
export type AuditActor = {
  type: "account";
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
    };

export type AuditAction =
  | "FLIGHT_CREATED"
  | "BOOKING_CREATED"
  | "BOOKING_CANCELLED";

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
