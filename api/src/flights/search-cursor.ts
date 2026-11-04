import { createHash } from "node:crypto";

import type { FlightSearchKey, FlightSearchQuery } from "./flight-search.js";

/** The parts of a search a cursor belongs to (Decision 17): everything but the page. */
export type SearchCursorScope = Pick<
  FlightSearchQuery,
  "origin" | "destination" | "departureDateFrom" | "departureDateTo" | "passengers" | "sort"
>;

const VERSION = 1;
const MAX_CURSOR_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type CursorKey = [string, string] | [number, string, string];

function sortKey(key: FlightSearchKey, sort: SearchCursorScope["sort"]): CursorKey {
  return sort === "price" ? [key.lowestFare, key.departureAt, key.id] : [key.departureAt, key.id];
}

/**
 * Binds the key to the query that produced it: a SHA-256 over the version,
 * the key and the normalised search. Not a secret signature — anyone can
 * compute it — so it does not stop a deliberate forgery; it does not need
 * to: a forged key for the same query is only another starting point of
 * that query's own order. What it stops is a cursor reused for another
 * search, or one damaged in transit, from being read as a wrong page.
 */
function seal(key: CursorKey, scope: SearchCursorScope): string {
  const material = JSON.stringify([
    VERSION,
    key,
    scope.origin,
    scope.destination,
    scope.departureDateFrom,
    scope.departureDateTo,
    scope.passengers,
    scope.sort,
  ]);
  return createHash("sha256").update(material).digest("base64url");
}

export function encodeSearchCursor(key: FlightSearchKey, scope: SearchCursorScope): string {
  const k = sortKey(key, scope.sort);
  return Buffer.from(JSON.stringify({ v: VERSION, k, s: seal(k, scope) })).toString("base64url");
}

export type DecodeSearchCursorResult =
  | { success: true; key: FlightSearchKey }
  | { success: false };

/**
 * The key a cursor carries, or failure when it does not decode, has the
 * wrong shape, or was made for another search. Never a best guess: a
 * cursor that is not exactly right answers 400, not a page.
 */
export function decodeSearchCursor(cursor: string, scope: SearchCursorScope): DecodeSearchCursorResult {
  if (cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) {
    return { success: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return { success: false };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { success: false };
  }
  const { v, k, s } = parsed as { v?: unknown; k?: unknown; s?: unknown };
  if (v !== VERSION || !Array.isArray(k) || typeof s !== "string") {
    return { success: false };
  }

  const key = readKey(k, scope.sort);
  if (key === undefined || s !== seal(k as CursorKey, scope)) {
    return { success: false };
  }
  return { success: true, key };
}

function readKey(k: unknown[], sort: SearchCursorScope["sort"]): FlightSearchKey | undefined {
  const [fare, departureAt, id] = sort === "price" ? k : [0, ...k];
  const expectedLength = sort === "price" ? 3 : 2;
  if (
    k.length !== expectedLength ||
    typeof departureAt !== "string" ||
    !ISO_INSTANT.test(departureAt) ||
    Number.isNaN(Date.parse(departureAt)) ||
    typeof id !== "string" ||
    !UUID.test(id) ||
    typeof fare !== "number" ||
    !Number.isSafeInteger(fare) ||
    fare < 0
  ) {
    return undefined;
  }
  return { departureAt, id, lowestFare: fare };
}
