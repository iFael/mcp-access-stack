const MAX_ASSERTION_BYTES = 8 * 1024;
const MAX_JWKS_BYTES = 32 * 1024;
const MAX_JWKS_KEYS = 16;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

interface AccessJwk {
  readonly kty: string;
  readonly kid: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
}

interface AccessClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly iat?: unknown;
}

interface CachedAccessKeys {
  readonly issuer: string;
  readonly expiresAt: number;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

export class CloudflareAccessAssertionVerifier {
  private cache: CachedAccessKeys | undefined;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async verify(assertion: string, issuerValue: string, audience: string): Promise<boolean> {
    try {
      if (assertion.length === 0 || assertion.length > MAX_ASSERTION_BYTES ||
          audience.length === 0 || audience.length > 512) return false;
      const issuerUrl = new URL(issuerValue);
      if (issuerUrl.protocol !== "https:" || issuerUrl.pathname !== "/" ||
          issuerUrl.search || issuerUrl.hash || issuerUrl.username || issuerUrl.password) return false;
      const issuer = issuerUrl.origin;
      const parts = assertion.split(".");
      if (parts.length !== 3 || parts.some((part) => part.length === 0 || part.length > MAX_ASSERTION_BYTES)) return false;

      const header = parseJsonPart(parts[0]!);
      const claims = parseJsonPart(parts[1]!) as AccessClaims;
      if (!isRecord(header) || header.alg !== "RS256" ||
          typeof header.kid !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(header.kid)) return false;
      if (!validClaims(claims, issuer, audience)) return false;

      const key = await this.getKey(issuer, header.kid);
      if (!key) return false;
      const signature = decodeBase64Url(parts[2]!);
      const signingInput = new TextEncoder().encode(parts[0] + "." + parts[1]);
      return await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        toArrayBuffer(signature),
        toArrayBuffer(signingInput),
      );
    } catch {
      return false;
    }
  }

  private async getKey(issuer: string, kid: string): Promise<CryptoKey | undefined> {
    if (this.cache && this.cache.issuer === issuer && this.cache.expiresAt > Date.now()) {
      const cached = this.cache.keys.get(kid);
      if (cached) return cached;
    }

    const jwksUrl = new URL("/cdn-cgi/access/certs", issuer);
    const response = await this.fetchImpl(jwksUrl, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const payload = await readBoundedJson(response);
    if (!isRecord(payload) || !Array.isArray(payload.keys) ||
        payload.keys.length === 0 || payload.keys.length > MAX_JWKS_KEYS) return undefined;

    const imported = new Map<string, CryptoKey>();
    for (const value of payload.keys) {
      if (!isAccessJwk(value)) continue;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: value.n!, e: value.e!, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        imported.set(value.kid, key);
      } catch {
        // Ignore malformed/unusable public keys; a matching valid key must still be present.
      }
    }
    const maxAgeSeconds = parseMaxAge(response.headers.get("cache-control"));
    this.cache = {
      issuer,
      expiresAt: Date.now() + maxAgeSeconds * 1000,
      keys: imported,
    };
    return imported.get(kid);
  }
}

function validClaims(claims: AccessClaims, issuer: string, audience: string): boolean {
  if (!isRecord(claims) || claims.iss !== issuer || typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) || claims.exp < Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS) {
    return false;
  }
  const audiences = typeof claims.aud === "string"
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((value) => typeof value === "string")
      ? claims.aud
      : [];
  if (!audiences.includes(audience)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + CLOCK_SKEW_SECONDS)) {
    return false;
  }
  if (claims.iat !== undefined &&
      (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > now + CLOCK_SKEW_SECONDS)) {
    return false;
  }
  return true;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_JWKS_BYTES)) {
    await response.body?.cancel();
    throw new Error("Access JWKS response exceeded the limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JWKS_BYTES) {
        await reader.cancel();
        throw new Error("Access JWKS response exceeded the limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function parseJsonPart(value: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value))) as unknown;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url.");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isAccessJwk(value: unknown): value is AccessJwk {
  return isRecord(value) &&
    value.kty === "RSA" &&
    typeof value.kid === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value.kid) &&
    (value.alg === undefined || value.alg === "RS256") &&
    (value.use === undefined || value.use === "sig") &&
    typeof value.n === "string" && /^[A-Za-z0-9_-]+$/u.test(value.n) &&
    typeof value.e === "string" && /^[A-Za-z0-9_-]+$/u.test(value.e);
}

function parseMaxAge(cacheControl: string | null): number {
  const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/iu);
  const seconds = match?.[1] ? Number(match[1]) : JWKS_CACHE_MS / 1000;
  if (!Number.isFinite(seconds)) return JWKS_CACHE_MS / 1000;
  return Math.min(Math.max(seconds, 30), 5 * 60);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
