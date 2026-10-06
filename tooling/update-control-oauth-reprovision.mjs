import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const OAUTH_REPROVISION_CONFIRMATION = "REPROVISION_OAUTH_AND_INVALIDATE_ALL_SESSIONS";
const OAUTH_REPROVISION_PATH = "/_operations/oauth/reprovision";
const GITHUB_ACTIONS_OIDC_HOST_SUFFIX = ".actions.githubusercontent.com";
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VALID_STATUSES = new Set(["not_executed", "in_progress", "completed", "outcome_unknown"]);
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_APPLY_ATTEMPTS = 20;
const APPLY_RETRY_DELAY_MS = 1_000;
const EXPECTED_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_OIDC_SUBJECT = "repo:iFael@185357494/mcp-access-stack@1379020190:environment:update-control-production";
const EXPECTED_OIDC_REPOSITORY = "iFael/mcp-access-stack";
const EXPECTED_OIDC_REPOSITORY_OWNER_ID = "185357494";
const EXPECTED_OIDC_REPOSITORY_ID = "1379020190";
const EXPECTED_OIDC_WORKFLOW_REF = "iFael/mcp-access-stack/.github/workflows/update-control-oauth-reprovision.yml@refs/heads/main";
const EXPECTED_OIDC_REF = "refs/heads/main";
const EXPECTED_OIDC_EVENT = "workflow_dispatch";
const EXPECTED_OIDC_ENVIRONMENT = "update-control-production";

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required reprovision configuration is missing: ${name}.`);
  }
  return value;
}

function readSettings(env, { requireConfirmation = true } = {}) {
  if (requireConfirmation && env.UPDATE_CONTROL_OAUTH_CONFIRM !== OAUTH_REPROVISION_CONFIRMATION) {
    throw new Error("Explicit OAuth reprovision confirmation is required.");
  }

  const operationId = requireValue(env, "UPDATE_CONTROL_OAUTH_OPERATION_ID");
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("OAuth reprovision operation ID must be a UUID.");
  }

  const publicUrlValue = requireValue(env, "MCP_UPDATE_CONTROL_PUBLIC_URL");
  if (/[\u0000-\u001f\u007f]/u.test(publicUrlValue) || publicUrlValue.includes("?") || publicUrlValue.includes("#")) {
    throw new Error("The public URL is invalid.");
  }
  let publicUrl;
  try {
    publicUrl = new URL(publicUrlValue);
  } catch {
    throw new Error("The public URL is invalid.");
  }
  if (publicUrl.protocol !== "https:") {
    throw new Error("The public URL must use HTTPS.");
  }
  const isRootOrigin = publicUrlValue === publicUrl.origin || publicUrlValue === `${publicUrl.origin}/`;
  if (publicUrl.username || publicUrl.password || publicUrl.port || publicUrl.pathname !== "/" ||
      publicUrl.search || publicUrl.hash || !isRootOrigin) {
    throw new Error("The public URL must be an HTTPS origin without credentials, nonstandard port, path, query, or fragment.");
  }
  const endpoint = new URL(OAUTH_REPROVISION_PATH, publicUrl.origin);

  return {
    operationId,
    endpoint,
    oidcRequestUrl: requireValue(env, "ACTIONS_ID_TOKEN_REQUEST_URL"),
    oidcRequestToken: requireValue(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
  };
}

function requireNextOwnerToken(env) {
  const value = requireValue(env, "UPDATE_CONTROL_OWNER_TOKEN_NEXT");
  if (value.length < 32 || /[\r\n]/u.test(value)) {
    throw new Error("The replacement owner token must be at least 32 characters and contain no line breaks.");
  }
}

function requestUrl(endpoint, operationId) {
  const url = new URL(endpoint);
  url.searchParams.set("operationId", operationId);
  return url;
}

async function readBoundedJson(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("OAuth reprovision response exceeded the configured size limit.");
  }

  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("OAuth reprovision response exceeded the configured size limit.");
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("OAuth reprovision endpoint returned invalid JSON.");
  }
}

async function requestGitHubActionsAssertion(settings, fetchImpl) {
  let requestUrl;
  try {
    requestUrl = new URL(settings.oidcRequestUrl);
    const isGitHubActionsOidcHost =
      requestUrl.hostname.length > GITHUB_ACTIONS_OIDC_HOST_SUFFIX.length &&
      requestUrl.hostname.endsWith(GITHUB_ACTIONS_OIDC_HOST_SUFFIX);
    if (
      requestUrl.protocol !== "https:" ||
      !isGitHubActionsOidcHost ||
      requestUrl.port !== "" ||
      requestUrl.username ||
      requestUrl.password ||
      requestUrl.hash
    ) {
      throw new Error("invalid");
    }
    requestUrl.searchParams.set(
      "audience",
      `urn:mcp-v3-update-control:oauth-reprovision:${settings.operationId}`,
    );
  } catch {
    throw new Error("GitHub Actions OIDC request endpoint is invalid.");
  }

  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${settings.oidcRequestToken}`,
        accept: "application/json",
      },
    });
  } catch {
    throw new Error("GitHub Actions OIDC token request failed.");
  }
  if (!response.ok) throw new Error("GitHub Actions OIDC token request failed.");
  const payload = await readBoundedJson(response);
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    typeof payload.value !== "string" ||
    payload.value.length === 0 ||
    payload.value.length > 8 * 1024
  ) {
    throw new Error("GitHub Actions OIDC token response is invalid.");
  }
  return payload.value;
}

async function createAuthenticatedSettings(env, fetchImpl, options) {
  const settings = readSettings(env, options);
  const assertion = await requestGitHubActionsAssertion(settings, fetchImpl);
  return { ...settings, assertion };
}

async function requestJson(fetchImpl, url, method, settings, body) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${settings.assertion}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("OAuth reprovision request failed; no credential was emitted.");
  }
  return { response, payload: await readBoundedJson(response) };
}

function decodeJwtJsonPart(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(
      atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)),
      (character) => character.charCodeAt(0),
    );
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeAssertion(assertion, operationId) {
  const parts = assertion.split(".");
  const header = parts.length === 3 ? decodeJwtJsonPart(parts[0]) : undefined;
  const claims = parts.length === 3 ? decodeJwtJsonPart(parts[1]) : undefined;
  const now = Math.floor(Date.now() / 1000);
  const iat = Number.isSafeInteger(claims?.iat) ? claims.iat : null;
  const nbf = Number.isSafeInteger(claims?.nbf) ? claims.nbf : null;
  const exp = Number.isSafeInteger(claims?.exp) ? claims.exp : null;
  return {
    formatValid: Boolean(header && claims),
    algMatches: header?.alg === "RS256",
    kidPresent: typeof header?.kid === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(header.kid),
    issuerMatches: claims?.iss === EXPECTED_OIDC_ISSUER,
    audienceMatches: claims?.aud === `urn:mcp-v3-update-control:oauth-reprovision:${operationId}`,
    subjectMatches: claims?.sub === EXPECTED_OIDC_SUBJECT,
    repositoryMatches: claims?.repository === EXPECTED_OIDC_REPOSITORY,
    repositoryOwnerIdMatches: claims?.repository_owner_id === EXPECTED_OIDC_REPOSITORY_OWNER_ID,
    repositoryIdMatches: claims?.repository_id === EXPECTED_OIDC_REPOSITORY_ID,
    workflowRefMatches: claims?.workflow_ref === EXPECTED_OIDC_WORKFLOW_REF,
    refMatches: claims?.ref === EXPECTED_OIDC_REF,
    eventNameMatches: claims?.event_name === EXPECTED_OIDC_EVENT,
    environmentMatches: claims?.environment === EXPECTED_OIDC_ENVIRONMENT,
    jtiPresent: typeof claims?.jti === "string" && claims.jti.length > 0 && claims.jti.length <= 256,
    issuedAtPresent: iat !== null,
    notBeforePresent: nbf !== null,
    expiresAtPresent: exp !== null,
    issuedAtFresh: iat !== null && iat <= now + 30 && iat >= now - 600,
    notBeforeValid: nbf !== null && nbf <= now + 30,
    notExpired: exp !== null && exp > now,
    lifetimeValid: iat !== null && exp !== null && exp > iat && exp - iat <= 600,
    temporalOrderValid: nbf !== null && exp !== null && nbf <= exp,
  };
}

function safeEndpointError(payload) {
  const error = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.error : undefined;
  return typeof error === "string" && /^[a-z0-9_]{1,64}$/u.test(error) ? error : null;
}

function validateStatusPayload(payload, operationId) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    payload.operationId !== operationId ||
    typeof payload.status !== "string" ||
    !VALID_STATUSES.has(payload.status)
  ) {
    throw new Error("OAuth reprovision endpoint returned an invalid operation status.");
  }
  return payload.status;
}

async function readStatus(fetchImpl, settings) {
  const { response, payload } = await requestJson(
    fetchImpl,
    requestUrl(settings.endpoint, settings.operationId),
    "GET",
    settings,
  );
  if (response.status === 409 && payload.error === "another_operation_active") {
    throw new Error("A different OAuth reprovision is active; do not rotate the Worker secret under a new operation ID.");
  }
  const status = validateStatusPayload(payload, settings.operationId);
  if (response.status !== 200) {
    throw new Error("OAuth reprovision status is unavailable; no credential was emitted.");
  }
  return status;
}

async function appendGitHubOutput(env, status) {
  const path = env.GITHUB_OUTPUT;
  if (typeof path !== "string" || path.length === 0) return;
  await appendFile(path, `status=${status}\ncompleted=${status === "completed"}\n`, { encoding: "utf8" });
}

export async function diagnoseOAuthReprovisionStatus({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const settings = await createAuthenticatedSettings(env, fetchImpl, { requireConfirmation: false });
  const assertion = summarizeAssertion(settings.assertion, settings.operationId);
  const { response, payload } = await requestJson(
    fetchImpl,
    requestUrl(settings.endpoint, settings.operationId),
    "GET",
    settings,
  );
  const status = payload && typeof payload === "object" && !Array.isArray(payload) &&
    payload.operationId === settings.operationId && typeof payload.status === "string" &&
    VALID_STATUSES.has(payload.status) ? payload.status : null;
  return {
    operationId: settings.operationId,
    httpStatus: response.status,
    status,
    error: safeEndpointError(payload),
    assertion,
  };
}

export async function preflightOAuthReprovision({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const settings = await createAuthenticatedSettings(env, fetchImpl);
  const status = await readStatus(fetchImpl, settings);
  if (status !== "completed") requireNextOwnerToken(env);
  await appendGitHubOutput(env, status);
  return { operationId: settings.operationId, status };
}

export async function executeOAuthReprovision({
  env = process.env,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxAttempts = MAX_APPLY_ATTEMPTS,
} = {}) {
  const settings = await createAuthenticatedSettings(env, fetchImpl);
  requireNextOwnerToken(env);

  const initialStatus = await readStatus(fetchImpl, settings);
  if (initialStatus === "completed") {
    return { operationId: settings.operationId, status: "completed" };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { response, payload } = await requestJson(
      fetchImpl,
      settings.endpoint,
      "POST",
      settings,
      { operationId: settings.operationId },
    );
    const status = validateStatusPayload(payload, settings.operationId);
    if (response.status === 200 && status === "completed") {
      return { operationId: settings.operationId, status };
    }
    if (response.status === 503 && status === "outcome_unknown") {
      throw new Error("OAuth reprovision is outcome_unknown. Keep the same operation ID and token; inspect status before an explicitly approved resume.");
    }
    if (response.status !== 202 || status !== "in_progress") {
      throw new Error("OAuth reprovision did not reach a resumable state; no automatic retry was attempted.");
    }
    if (attempt + 1 < maxAttempts) await sleep(APPLY_RETRY_DELAY_MS);
  }

  throw new Error("OAuth reprovision remains in_progress. Reconcile and resume only with the same operation ID and replacement token.");
}

async function main() {
  const mode = process.argv[2];
  try {
    if (mode === "diagnose") {
      const result = await diagnoseOAuthReprovisionStatus();
      process.stdout.write(`OAuth reprovision diagnosis: ${JSON.stringify(result)}\n`);
      return;
    }
    if (mode === "preflight") {
      const result = await preflightOAuthReprovision();
      process.stdout.write(`OAuth reprovision preflight status: ${result.status}.\n`);
      return;
    }
    if (mode === "apply") {
      const result = await executeOAuthReprovision();
      process.stdout.write(`OAuth reprovision terminal status: ${result.status}.\n`);
      return;
    }
    throw new Error("Expected mode: diagnose, preflight or apply.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected failure.";
    process.stderr.write(`OAuth reprovision ${mode === "preflight" ? "preflight" : "operation"} stopped safely: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
