export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_ACTIONS_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const EXPECTED_REPOSITORY = "iFael/mcp-access-stack";
const EXPECTED_REPOSITORY_OWNER_ID = "185357494";
const EXPECTED_REPOSITORY_ID = "1379020190";
const EXPECTED_WORKFLOW_REF =
  "iFael/mcp-access-stack/.github/workflows/update-control-oauth-reprovision.yml@refs/heads/main";
const EXPECTED_REF = "refs/heads/main";
const EXPECTED_EVENT = "workflow_dispatch";
const EXPECTED_ENVIRONMENT = "update-control-production";
const EXPECTED_SUBJECT =
  "repo:iFael@185357494/mcp-access-stack@1379020190:environment:update-control-production";
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ASSERTION_BYTES = 8 * 1024;
const MAX_JWKS_BYTES = 32 * 1024;
const MAX_JWKS_KEYS = 16;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_AGE_SECONDS = 10 * 60;
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;

interface GitHubJwk {
  readonly kty: string;
  readonly kid: string;
  readonly alg?: string;
  readonly use?: string;
  readonly key_ops?: readonly string[];
  readonly n?: string;
  readonly e?: string;
}

interface GitHubActionsClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly sub?: unknown;
  readonly repository?: unknown;
  readonly repository_owner_id?: unknown;
  readonly repository_id?: unknown;
  readonly workflow_ref?: unknown;
  readonly ref?: unknown;
  readonly event_name?: unknown;
  readonly environment?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly iat?: unknown;
  readonly jti?: unknown;
}

interface CachedGitHubKeys {
  readonly expiresAt: number;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

export type GitHubActionsOidcVerificationStage =
  | "verified"
  | "input"
  | "structure"
  | "header"
  | "claims"
  | "jwks_fetch"
  | "jwks_http"
  | "jwks_shape"
  | "jwks_kid"
  | "jwks_import"
  | "signature"
  | "exception";

export interface GitHubActionsOidcVerificationResult {
  readonly valid: boolean;
  readonly stage: GitHubActionsOidcVerificationStage;
}

export function githubActionsOAuthReprovisionAudience(operationId: string): string {
  return `urn:mcp-v3-update-control:oauth-reprovision:${operationId}`;
}

export class GitHubActionsOidcAssertionVerifier {
  private cache: CachedGitHubKeys | undefined;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async verify(assertion: string, operationId: string): Promise<boolean> {
    return (await this.verifyWithStage(assertion, operationId)).valid;
  }

  async verifyWithStage(assertion: string, operationId: string): Promise<GitHubActionsOidcVerificationResult> {
    try {
      if (typeof assertion !== "string" || assertion.length === 0 ||
          assertion.length > MAX_ASSERTION_BYTES ||
          !OPERATION_ID_PATTERN.test(operationId)) return { valid: false, stage: "input" };

      const parts = assertion.split(".");
      if (parts.length !== 3 ||
          parts.some((part) => part.length === 0 || part.length > MAX_ASSERTION_BYTES)) {
        return { valid: false, stage: "structure" };
      }

      let header: unknown;
      let claims: GitHubActionsClaims;
      try {
        header = parseJsonPart(parts[0]!);
        claims = parseJsonPart(parts[1]!) as GitHubActionsClaims;
      } catch {
        return { valid: false, stage: "structure" };
      }
      if (!isRecord(header) || header.alg !== "RS256" ||
          typeof header.kid !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(header.kid) ||
          header.jku !== undefined || header.x5u !== undefined || header.crit !== undefined) {
        return { valid: false, stage: "header" };
      }
      if (!validClaims(claims, operationId)) return { valid: false, stage: "claims" };

      const keyResult = await this.getKeyWithStage(header.kid);
      if (!keyResult.key) return { valid: false, stage: keyResult.stage };
      const signature = decodeBase64Url(parts[2]!);
      const signingInput = new TextEncoder().encode(parts[0] + "." + parts[1]);
      const valid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        keyResult.key,
        toArrayBuffer(signature),
        toArrayBuffer(signingInput),
      );
      return { valid, stage: valid ? "verified" : "signature" };
    } catch {
      return { valid: false, stage: "exception" };
    }
  }

  private async getKeyWithStage(
    kid: string,
  ): Promise<{ readonly key?: CryptoKey; readonly stage: GitHubActionsOidcVerificationStage }> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      const cached = this.cache.keys.get(kid);
      if (cached) return { key: cached, stage: "verified" };
    }

    let response: Response;
    try {
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(GITHUB_ACTIONS_JWKS_URL, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/json" },
      });
    } catch {
      return { stage: "jwks_fetch" };
    }
    if (!response.ok) return { stage: "jwks_http" };

    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch {
      return { stage: "jwks_shape" };
    }
    if (!isRecord(payload) || !Array.isArray(payload.keys) ||
        payload.keys.length === 0 || payload.keys.length > MAX_JWKS_KEYS) {
      return { stage: "jwks_shape" };
    }

    const imported = new Map<string, CryptoKey>();
    let matchingKidSeen = false;
    for (const value of payload.keys) {
      if (isRecord(value) && value.kid === kid) matchingKidSeen = true;
      if (!isGitHubJwk(value)) continue;
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
        // A malformed unrelated key cannot authorize a request; a matching usable key must exist.
      }
    }

    this.cache = {
      expiresAt: Date.now() + parseMaxAge(response.headers.get("cache-control")),
      keys: imported,
    };
    const key = imported.get(kid);
    if (key) return { key, stage: "verified" };
    return { stage: matchingKidSeen ? "jwks_import" : "jwks_kid" };
  }
}

function validClaims(claims: GitHubActionsClaims, operationId: string): boolean {
  if (!isRecord(claims) ||
      claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER ||
      claims.aud !== githubActionsOAuthReprovisionAudience(operationId) ||
      claims.sub !== EXPECTED_SUBJECT ||
      claims.repository !== EXPECTED_REPOSITORY ||
      claims.repository_owner_id !== EXPECTED_REPOSITORY_OWNER_ID ||
      claims.repository_id !== EXPECTED_REPOSITORY_ID ||
      claims.workflow_ref !== EXPECTED_WORKFLOW_REF ||
      claims.ref !== EXPECTED_REF ||
      claims.event_name !== EXPECTED_EVENT ||
      claims.environment !== EXPECTED_ENVIRONMENT ||
      typeof claims.jti !== "string" ||
      claims.jti.length === 0 ||
      claims.jti.length > 256) return false;

  const now = Math.floor(Date.now() / 1000);
  const { exp, nbf, iat } = claims;
  if (!isNumericDate(exp) || !isNumericDate(nbf) || !isNumericDate(iat) ||
      exp <= now ||
      nbf > now + CLOCK_SKEW_SECONDS ||
      iat > now + CLOCK_SKEW_SECONDS ||
      iat < now - MAX_TOKEN_AGE_SECONDS ||
      exp <= iat ||
      exp - iat > MAX_TOKEN_LIFETIME_SECONDS ||
      nbf > exp) return false;

  return true;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_JWKS_BYTES)) {
    await response.body?.cancel();
    throw new Error("GitHub JWKS response exceeded the configured size limit.");
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
        throw new Error("GitHub JWKS response exceeded the configured size limit.");
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

function isGitHubJwk(value: unknown): value is GitHubJwk {
  return isRecord(value) &&
    value.kty === "RSA" &&
    typeof value.kid === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value.kid) &&
    (value.alg === undefined || value.alg === "RS256") &&
    (value.use === undefined || value.use === "sig") &&
    (value.key_ops === undefined ||
      (Array.isArray(value.key_ops) && value.key_ops.includes("verify") &&
       value.key_ops.every((operation) => operation === "verify"))) &&
    typeof value.n === "string" && /^[A-Za-z0-9_-]+$/u.test(value.n) &&
    typeof value.e === "string" && /^[A-Za-z0-9_-]+$/u.test(value.e);
}

function parseMaxAge(cacheControl: string | null): number {
  const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/iu);
  const seconds = match?.[1] ? Number(match[1]) : JWKS_CACHE_MS / 1000;
  if (!Number.isFinite(seconds)) return JWKS_CACHE_MS;
  return Math.min(Math.max(seconds, 30), JWKS_CACHE_MS / 1000) * 1000;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
