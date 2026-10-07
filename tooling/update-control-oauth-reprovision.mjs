import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const OAUTH_REPROVISION_PATH = "/_operations/oauth/reprovision";
const SIGNATURE_DOMAIN = "mcp-v3-update-control:oauth-reprovision";
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VALID_STATUSES = new Set(["not_executed", "in_progress", "completed", "outcome_unknown"]);
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_APPLY_ATTEMPTS = 20;
const APPLY_RETRY_DELAY_MS = 1_000;

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required reprovision configuration is missing: ${name}.`);
  }
  return value;
}

function readPublicUrl(env) {
  const raw = requireValue(env, "MCP_UPDATE_CONTROL_PUBLIC_URL");
  if (/[\u0000-\u001f\u007f]/u.test(raw) || raw.includes("?") || raw.includes("#")) {
    throw new Error("The public URL is invalid.");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The public URL is invalid.");
  }
  const isRootOrigin = raw === url.origin || raw === `${url.origin}/`;
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash || !isRootOrigin) {
    throw new Error("The public URL must be an HTTPS origin.");
  }
  return url;
}

function readSettings(env, { requiredMode } = {}) {
  if (requiredMode && env.UPDATE_CONTROL_OAUTH_MODE !== requiredMode) {
    throw new Error(`OAuth reprovision mode ${requiredMode} is required.`);
  }
  const operationId = requireValue(env, "UPDATE_CONTROL_OAUTH_OPERATION_ID");
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("OAuth reprovision operation ID must be a UUID.");
  }
  const hmacKey = requireValue(env, "UPDATE_CONTROL_ADMIN_HMAC_KEY");
  if (!/^[0-9a-f]{64}$/u.test(hmacKey)) {
    throw new Error("The Update Control administrative HMAC key must be 64 lowercase hexadecimal characters.");
  }
  const publicUrl = readPublicUrl(env);
  return {
    operationId,
    endpoint: new URL(OAUTH_REPROVISION_PATH, publicUrl.origin),
    hmacKey,
  };
}

function requestUrl(endpoint, operationId) {
  const url = new URL(endpoint);
  url.searchParams.set("operationId", operationId);
  return url;
}

function hexBytes(value) {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function asArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createAuthorization(method, operationId, hmacKey) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = [
    SIGNATURE_DOMAIN,
    "v1",
    method,
    OAUTH_REPROVISION_PATH,
    operationId,
    timestamp,
  ].join("\n");
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(hexBytes(hmacKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    asArrayBuffer(new TextEncoder().encode(canonical)),
  );
  return `HMAC-SHA256 v1=${timestamp}.${toHex(new Uint8Array(signature))}`;
}

async function readBoundedJson(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
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

async function requestJson(fetchImpl, url, method, settings, body) {
  const authorization = await createAuthorization(method, settings.operationId, settings.hmacKey);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("OAuth reprovision request failed; no credential was emitted.");
  }
  return { response, payload: await readBoundedJson(response) };
}

function safeEndpointError(payload) {
  const error = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.error : undefined;
  return typeof error === "string" && /^[a-z0-9_]{1,64}$/u.test(error) ? error : null;
}

function safeStatus(payload, operationId) {
  return payload && typeof payload === "object" && !Array.isArray(payload) &&
    payload.operationId === operationId && typeof payload.status === "string" &&
    VALID_STATUSES.has(payload.status) ? payload.status : null;
}

function validateStatusPayload(payload, operationId) {
  const status = safeStatus(payload, operationId);
  if (!status) throw new Error("OAuth reprovision endpoint returned an invalid operation status.");
  return status;
}

async function readStatus(fetchImpl, settings) {
  const { response, payload } = await requestJson(
    fetchImpl,
    requestUrl(settings.endpoint, settings.operationId),
    "GET",
    settings,
  );
  if (response.status === 409 && payload.error === "another_operation_active") {
    throw new Error("A different OAuth reprovision is active; reconcile it before starting another.");
  }
  const status = validateStatusPayload(payload, settings.operationId);
  if (response.status !== 200) {
    throw new Error("OAuth reprovision status is unavailable.");
  }
  return status;
}

async function appendGitHubOutput(env, status) {
  const path = env.GITHUB_OUTPUT;
  if (typeof path !== "string" || valueIsUnsafePath(path)) return;
  await appendFile(path, `status=${status}\ncompleted=${status === "completed"}\n`, { encoding: "utf8" });
}

function valueIsUnsafePath(value) {
  return value.length === 0 || /[\r\n\0]/u.test(value);
}

export async function diagnoseOAuthReprovisionStatus({ env = process.env, fetchImpl = fetch } = {}) {
  const settings = readSettings(env);
  const { response, payload } = await requestJson(
    fetchImpl,
    requestUrl(settings.endpoint, settings.operationId),
    "GET",
    settings,
  );
  return {
    operationId: settings.operationId,
    httpStatus: response.status,
    status: safeStatus(payload, settings.operationId),
    error: safeEndpointError(payload),
  };
}

export async function preflightOAuthReprovision({ env = process.env, fetchImpl = fetch } = {}) {
  const settings = readSettings(env, { requiredMode: "apply" });
  const status = await readStatus(fetchImpl, settings);
  await appendGitHubOutput(env, status);
  return { operationId: settings.operationId, status };
}

export async function executeOAuthReprovision({
  env = process.env,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxAttempts = MAX_APPLY_ATTEMPTS,
} = {}) {
  const settings = readSettings(env, { requiredMode: "apply" });
  const initialStatus = await readStatus(fetchImpl, settings);
  if (initialStatus === "completed") return { operationId: settings.operationId, status: "completed" };
  if (initialStatus === "outcome_unknown") {
    throw new Error("OAuth reprovision is outcome_unknown. Reconcile the same operation ID before any resume.");
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
      throw new Error("OAuth reprovision is outcome_unknown. Reconcile the same operation ID before any resume.");
    }
    if (response.status !== 202 || status !== "in_progress") {
      throw new Error("OAuth reprovision did not reach a resumable state; no automatic retry was attempted.");
    }
    if (attempt + 1 < maxAttempts) await sleep(APPLY_RETRY_DELAY_MS);
  }
  throw new Error("OAuth reprovision remains in_progress. Reconcile and resume only with the same operation ID.");
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
