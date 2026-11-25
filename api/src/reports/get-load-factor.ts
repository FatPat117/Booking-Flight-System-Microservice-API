import type { ValidationIssue } from "../types.js";
import type { AdminReports } from "./admin-reports.js";
import { decodeReportCursor, encodeReportCursor, type ReportCursorScope } from "./report-cursor.js";
import { validateLoadFactorQuery } from "./report-validation.js";
import {
  toLoadFactorClassView,
  toReportFlightView,
  type LoadFactorClassView,
  type ReportFlightView,
} from "./report-views.js";

export type LoadFactorItem = ReportFlightView & Readonly<{ classes: readonly LoadFactorClassView[] }>;

export type GetLoadFactorResult =
  | Readonly<{
      outcome: "success";
      items: readonly LoadFactorItem[];
      page: { hasNextPage: boolean; nextCursor: string | null };
    }>
  | Readonly<{ outcome: "validation_failed"; issues: ValidationIssue[] }>
  | Readonly<{ outcome: "invalid_cursor" }>;

export type GetLoadFactor = (raw: Record<string, unknown>) => Promise<GetLoadFactorResult>;

/**
 * US-ADM-02 (Decision 19): validate, continue after the cursor's
 * `(departureAt, id)`, read one page in one statement, derive each class's
 * load factor. Like search, a validation problem wins over a bad cursor.
 */
export function createGetLoadFactor(dependencies: {
  adminReports: AdminReports;
  getCurrentTime: () => Date;
}): GetLoadFactor {
  const { adminReports, getCurrentTime } = dependencies;

  return async (raw) => {
    const validated = validateLoadFactorQuery(raw);
    if (!validated.success) {
      return { outcome: "validation_failed", issues: validated.issues };
    }
    const { query, cursor } = validated.value;
    const scope: ReportCursorScope = {
      report: "load-factor",
      filter: [query.dateFrom, query.dateTo, query.origin ?? null],
    };

    let after;
    if (cursor !== undefined) {
      after = decodeReportCursor(cursor, scope);
      if (after === undefined) {
        return { outcome: "invalid_cursor" };
      }
    }

    const now = getCurrentTime();
    const page = await adminReports.loadFactor(after === undefined ? query : { ...query, after }, now);
    const last = page.items.at(-1);
    return {
      outcome: "success",
      items: page.items.map((flight) => ({
        ...toReportFlightView(flight, now),
        classes: flight.classes.map(toLoadFactorClassView),
      })),
      page: {
        hasNextPage: page.hasNextPage,
        nextCursor:
          page.hasNextPage && last !== undefined
            ? encodeReportCursor({ at: last.departureAt, id: last.id }, scope)
            : null,
      },
    };
  };
}
