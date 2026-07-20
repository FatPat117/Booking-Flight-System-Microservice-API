export type AuditActor = {
  type: "admin_api_key";
  id: "admin";
};

export type AuditTarget = {
  type: "flight";
  id: string;
};

export type AuditAction = "FLIGHT_CREATED";

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
  record(input: AuditRecordInput): void;
}
