import { parseLocalDate } from "../flights/flight-search-validation.js";
import type { ValidationIssue, ValidationResult } from "../types.js";
import type { AuditLogQuery, LoadFactorQuery } from "./admin-reports.js";

/** Decision 19: ceilings, because a report's snapshot holds back vacuum. */
export const MAX_REPORT_DAYS = 31;
export const DEFAULT_LOAD_FACTOR_LIMIT = 20;
export const MAX_LOAD_FACTOR_LIMIT = 50;
export const DEFAULT_AUDIT_LOG_LIMIT = 50;
export const MAX_AUDIT_LOG_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const AIRPORT_CODE = /^[A-Z]{3}$/;
const POSITIVE_INTEGER = /^\d{1,3}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const TARGET_TYPES = ["flight", "booking", "airport", "aircraft", "payment"] as const;
const ACTION = /^[A-Z][A-Z_]{0,63}$/;
const MAX_FILTER_LENGTH = 100;

type Raw = Record<string, unknown>;

export type ValidReport<Q> = Readonly<{ query: Omit<Q, "after">; cursor: string | undefined }>;

function limitOf(raw: unknown, fallback: number, max: number, issues: ValidationIssue[]): number | undefined {
  if (raw === undefined) return fallback;
  const value = typeof raw === "string" && POSITIVE_INTEGER.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (value >= 1 && value <= max) return value;
  issues.push({ field: "limit", code: "INVALID_LIMIT", message: `limit must be an integer from 1 to ${max}` });
  return undefined;
}

function cursorOf(raw: unknown, issues: ValidationIssue[]): string | undefined {
  if (raw !== undefined && typeof raw !== "string") {
    issues.push({ field: "cursor", code: "INVALID_CURSOR", message: "cursor must be a single value" });
  }
  return typeof raw === "string" ? raw : undefined;
}

/** A single, non-empty, bounded string, or an issue. Query values may arrive as arrays. */
function textOf(raw: Raw, field: string, issues: ValidationIssue[]): string | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_FILTER_LENGTH) {
    issues.push({ field, code: "INVALID_FILTER", message: `${field} must be one non-empty value of at most ${MAX_FILTER_LENGTH} characters` });
    return undefined;
  }
  return value.trim();
}

/** Query string → load factor report (US-ADM-02): local dates, at most 31 days. */
export function validateLoadFactorQuery(raw: Raw): ValidationResult<ValidReport<LoadFactorQuery>> {
  const issues: ValidationIssue[] = [];

  const date = (field: "dateFrom" | "dateTo"): [string, number] | undefined => {
    const value = raw[field];
    if (value === undefined || value === "") {
      issues.push({ field, code: "MISSING_FIELD", message: `${field} is required` });
      return undefined;
    }
    const days = typeof value === "string" ? parseLocalDate(value) : undefined;
    if (typeof value !== "string" || days === undefined) {
      issues.push({ field, code: "INVALID_DATE", message: `${field} must be a calendar date (YYYY-MM-DD)` });
      return undefined;
    }
    return [value, days];
  };
  const from = date("dateFrom");
  const to = date("dateTo");
  if (from !== undefined && to !== undefined) {
    if (to[1] < from[1]) {
      issues.push({ field: "dateTo", code: "INVALID_DATE_RANGE", message: "dateTo must not be before dateFrom" });
    } else if (to[1] - from[1] + 1 > MAX_REPORT_DAYS) {
      issues.push({ field: "dateTo", code: "DATE_RANGE_TOO_LONG", message: `A report covers at most ${MAX_REPORT_DAYS} days` });
    }
  }

  let origin: string | undefined;
  if (raw.origin !== undefined) {
    const normalized = typeof raw.origin === "string" ? raw.origin.trim().toUpperCase() : "";
    if (AIRPORT_CODE.test(normalized)) {
      origin = normalized;
    } else {
      issues.push({ field: "origin", code: "INVALID_AIRPORT_CODE", message: "origin must be a three-letter airport code" });
    }
  }

  const limit = limitOf(raw.limit, DEFAULT_LOAD_FACTOR_LIMIT, MAX_LOAD_FACTOR_LIMIT, issues);
  const cursor = cursorOf(raw.cursor, issues);

  if (issues.length > 0 || from === undefined || to === undefined || limit === undefined) {
    return { success: false, issues };
  }
  return {
    success: true,
    value: {
      query: { dateFrom: from[0], dateTo: to[0], ...(origin === undefined ? {} : { origin }), limit },
      cursor,
    },
  };
}

/**
 * Query string → audit log query (US-ADM-03). A target or a range of at most
 * 31 days is required, so the query always has an index to start from
 * (Decision 19); actor and action only narrow it.
 */
export function validateAuditLogQuery(raw: Raw): ValidationResult<ValidReport<AuditLogQuery>> {
  const issues: ValidationIssue[] = [];

  const targetType = textOf(raw, "targetType", issues);
  const targetId = textOf(raw, "targetId", issues);
  if (targetType !== undefined && !(TARGET_TYPES as readonly string[]).includes(targetType)) {
    issues.push({ field: "targetType", code: "INVALID_TARGET_TYPE", message: `targetType must be one of ${TARGET_TYPES.join(", ")}` });
  }
  if ((raw.targetType === undefined) !== (raw.targetId === undefined)) {
    issues.push({ field: raw.targetType === undefined ? "targetType" : "targetId", code: "MISSING_FIELD", message: "targetType and targetId go together" });
  }

  const instant = (field: "from" | "to"): [string, number] | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    const time = typeof value === "string" && ISO_INSTANT.test(value) ? Date.parse(value) : NaN;
    if (Number.isNaN(time)) {
      issues.push({ field, code: "INVALID_INSTANT", message: `${field} must be an ISO 8601 instant with a zone` });
      return undefined;
    }
    return [new Date(time).toISOString(), time];
  };
  const from = instant("from");
  const to = instant("to");
  if ((raw.from === undefined) !== (raw.to === undefined)) {
    issues.push({ field: raw.from === undefined ? "from" : "to", code: "MISSING_FIELD", message: "from and to go together" });
  }
  if (from !== undefined && to !== undefined) {
    if (to[1] <= from[1]) {
      issues.push({ field: "to", code: "INVALID_TIME_RANGE", message: "to must be after from" });
    } else if (to[1] - from[1] > MAX_REPORT_DAYS * DAY_MS) {
      issues.push({ field: "to", code: "TIME_RANGE_TOO_LONG", message: `A range covers at most ${MAX_REPORT_DAYS} days` });
    }
  }

  const hasTarget = raw.targetType !== undefined || raw.targetId !== undefined;
  const hasRange = raw.from !== undefined || raw.to !== undefined;
  if (!hasTarget && !hasRange) {
    issues.push({ field: "targetType", code: "FILTER_REQUIRED", message: "Filter by a target (targetType and targetId) or a time range (from and to)" });
  }

  const actorType = textOf(raw, "actorType", issues);
  const actorId = textOf(raw, "actorId", issues);
  const action = textOf(raw, "action", issues);
  if (action !== undefined && !ACTION.test(action)) {
    issues.push({ field: "action", code: "INVALID_FILTER", message: "action must be an audit action name, e.g. BOOKING_CANCELLED" });
  }

  const limit = limitOf(raw.limit, DEFAULT_AUDIT_LOG_LIMIT, MAX_AUDIT_LOG_LIMIT, issues);
  const cursor = cursorOf(raw.cursor, issues);

  if (issues.length > 0 || limit === undefined) {
    return { success: false, issues };
  }
  return {
    success: true,
    value: {
      query: {
        ...(targetType !== undefined && targetId !== undefined ? { target: { type: targetType, id: targetId } } : {}),
        ...(from !== undefined && to !== undefined ? { range: { from: from[0], to: to[0] } } : {}),
        ...(actorType === undefined ? {} : { actorType }),
        ...(actorId === undefined ? {} : { actorId }),
        ...(action === undefined ? {} : { action }),
        limit,
      },
      cursor,
    },
  };
}
