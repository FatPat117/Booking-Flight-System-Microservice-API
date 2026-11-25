import { createHash } from "node:crypto";

import type { ReportKey } from "./admin-reports.js";

const VERSION = 1;
const MAX_CURSOR_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Everything a report's page depends on except the page itself: the report's
 * name and its normalised filter, in a fixed order.
 */
export type ReportCursorScope = Readonly<{ report: string; filter: readonly unknown[] }>;

/**
 * Binds the key to the query that produced it, like the search cursor (Day
 * 51): a SHA-256, not a signature. Decision 19 asked whether that is enough
 * for the audit log, which is not public, and it is: the caller is an admin
 * who may run any filter, the filter always comes from the request, and the
 * cursor only carries a position. A forged one starts a page somewhere inside
 * a query the admin was allowed to run. If a narrower role ever reads these
 * reports, its restriction belongs in the WHERE, never in the cursor.
 */
function bindToQuery(key: readonly [string, string], scope: ReportCursorScope): string {
  return createHash("sha256")
    .update(JSON.stringify([VERSION, key, scope.report, scope.filter]))
    .digest("base64url");
}

export function encodeReportCursor(key: ReportKey, scope: ReportCursorScope): string {
  const k = [key.at, key.id] as const;
  return Buffer.from(JSON.stringify({ v: VERSION, k, s: bindToQuery(k, scope) })).toString("base64url");
}

/**
 * The key a cursor carries, or undefined when it does not decode, has the
 * wrong shape, or was made for another report or filter. Never a best
 * guess: the route answers 400.
 */
export function decodeReportCursor(cursor: string, scope: ReportCursorScope): ReportKey | undefined {
  if (cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const { v, k, s } = parsed as { v?: unknown; k?: unknown; s?: unknown };
  if (v !== VERSION || !Array.isArray(k) || k.length !== 2 || typeof s !== "string") {
    return undefined;
  }
  const [at, id] = k as unknown[];
  if (
    typeof at !== "string" ||
    !ISO_INSTANT.test(at) ||
    Number.isNaN(Date.parse(at)) ||
    typeof id !== "string" ||
    !UUID.test(id) ||
    s !== bindToQuery([at, id], scope)
  ) {
    return undefined;
  }
  return { at, id };
}
