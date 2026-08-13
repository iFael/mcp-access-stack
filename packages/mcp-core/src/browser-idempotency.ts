import { createHash } from "node:crypto";
import type { BrowserOperation } from "./browser-contracts.js";

const BROWSER_IDEMPOTENCY_VERSION = "browser-v2";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON does not support non-finite numbers.");
      }
      return JSON.stringify(value);
    case "undefined":
      return "null";
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
      }
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
  }
}

export function createBrowserOperationFingerprint(
  operation: BrowserOperation,
  input: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ operation, input }))
    .digest("hex");
}

export function createBrowserIdempotencyKey(
  invocationId: string,
  fingerprint: string,
): string {
  return createHash("sha256")
    .update(`${BROWSER_IDEMPOTENCY_VERSION}\0${invocationId}\0${fingerprint}`)
    .digest("hex");
}
