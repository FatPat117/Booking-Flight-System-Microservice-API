import { createHash } from "node:crypto";

/**
 * What "the same request" means for an Idempotency-Key (BR-PAY-02, Day 49B).
 *
 * The body is the *validated* value, canonicalised before hashing: object
 * keys are sorted at every depth, array order is kept. `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are one request; hashing the raw string would call them two
 * and answer `422 IDEMPOTENCY_KEY_REUSED` to a client that changed nothing.
 */
export function requestFingerprint(request: {
  method: string;
  path: string;
  body: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        method: request.method,
        path: request.path,
        body: request.body,
      }),
    )
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
