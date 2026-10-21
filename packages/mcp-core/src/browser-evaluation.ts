import { AppError } from "./errors.js";

const PRIVATE_FIELDS = /^(?:password|passwd|secret|token|accessToken|refreshToken|authorization|cookie|session|privateKey|clientSecret)$/iu;

/** Sanitize evaluation data before returning it through MCP or logging it. */
export function sanitizeBrowserEvaluation(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    if (++nodes > 5000 || depth > 12) throw new AppError("LIMIT_EXCEEDED", "Browser evaluation exceeded complexity limits.");
    if (current == null || typeof current === "boolean" || typeof current === "number") return current;
    if (typeof current === "string") return current
      .replace(/Bearer\s+[a-z0-9._~+/-]+/giu, "[redacted]")
      .replace(/(?:password|token|secret)=([^&\s]+)/giu, "$1=[redacted]");
    if (typeof current !== "object") return null;
    if (seen.has(current)) throw new AppError("INVALID_ARGUMENT", "Browser evaluation returned a cyclic value.");
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > 1000) throw new AppError("LIMIT_EXCEEDED", "Browser evaluation returned too many entries.");
      return current.map((item) => visit(item, depth + 1));
    }
    const entries = Object.entries(current as Record<string, unknown>);
    if (entries.length > 1000) throw new AppError("LIMIT_EXCEEDED", "Browser evaluation returned too many properties.");
    return Object.fromEntries(entries.map(([key, val]) =>
      [key.slice(0, 200), PRIVATE_FIELDS.test(key) ? "[redacted]" : visit(val, depth + 1)]));
  };
  const sanitized = visit(value ?? null, 0);
  const json = JSON.stringify(sanitized);
  if (!json || Buffer.byteLength(json, "utf8") > 256 * 1024) {
    throw new AppError("LIMIT_EXCEEDED", "Browser evaluation exceeds the 256 KiB output limit.");
  }
  return sanitized;
}
