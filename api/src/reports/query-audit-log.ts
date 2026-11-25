import type { ValidationIssue } from "../types.js";
import type { AdminReports, AuditLogEntry } from "./admin-reports.js";
import { decodeReportCursor, encodeReportCursor, type ReportCursorScope } from "./report-cursor.js";
import { validateAuditLogQuery } from "./report-validation.js";

export type QueryAuditLogResult =
  | Readonly<{
      outcome: "success";
      items: readonly AuditLogEntry[];
      page: { hasNextPage: boolean; nextCursor: string | null };
    }>
  | Readonly<{ outcome: "validation_failed"; issues: ValidationIssue[] }>
  | Readonly<{ outcome: "invalid_cursor" }>;

export type QueryAuditLog = (raw: Record<string, unknown>) => Promise<QueryAuditLogResult>;

/**
 * US-ADM-03 (Decision 19): a target or a bounded range, newest first, keyset
 * pages on `(occurredAt, id)`. The cursor is bound to every filter, so one
 * made for another filter is refused, never read as a wrong page.
 */
export function createQueryAuditLog(dependencies: { adminReports: AdminReports }): QueryAuditLog {
  const { adminReports } = dependencies;

  return async (raw) => {
    const validated = validateAuditLogQuery(raw);
    if (!validated.success) {
      return { outcome: "validation_failed", issues: validated.issues };
    }
    const { query, cursor } = validated.value;
    const scope: ReportCursorScope = {
      report: "audit-log",
      filter: [
        query.target?.type ?? null,
        query.target?.id ?? null,
        query.range?.from ?? null,
        query.range?.to ?? null,
        query.actorType ?? null,
        query.actorId ?? null,
        query.action ?? null,
      ],
    };

    let after;
    if (cursor !== undefined) {
      after = decodeReportCursor(cursor, scope);
      if (after === undefined) {
        return { outcome: "invalid_cursor" };
      }
    }

    const page = await adminReports.auditLog(after === undefined ? query : { ...query, after });
    const last = page.items.at(-1);
    return {
      outcome: "success",
      items: page.items,
      page: {
        hasNextPage: page.hasNextPage,
        nextCursor:
          page.hasNextPage && last !== undefined
            ? encodeReportCursor({ at: last.occurredAt, id: last.id }, scope)
            : null,
      },
    };
  };
}
