import { pathToFileURL } from "node:url";

export const ADMIN_BOOTSTRAP_CONFIRMATION = "BOOTSTRAP_UPDATE_CONTROL_ADMIN";
const ADMIN_BOOTSTRAP_PATH = "/_operations/admin/bootstrap";
const SIGNATURE_DOMAIN = "mcp-v3-update-control:admin-bootstrap";
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VALID_STATUSES = new Set(["not_executed", "ready", "completed", "expired"]);
const MAX_RESPONSE_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required admin-bootstrap configuration is missing: ${name}.`);
  }
  return value;
}

function readSettings(env, { requireConfirmation = true } = {}) {
  if (requireConfirmation && env.UPDATE_CONTROL_ADMIN_BOOTSTRAP_CONFIRM !== ADMIN_BOOTSTRAP_CONFIRMATION) {
    throw new Error("Explicit admin-bootstrap confirmation is required.");
  }
  const operationId = requireValue(env, "UPDATE_CONTROL_ADMIN_BOOTSTRAP_OPERATION_ID");
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("Admin-bootstrap operation ID must be a UUID.");
  }
  const hmacKey = requireValue(env, "UPDATE_CONTROL_ADMIN_HMAC_KEY");
  if (!/^[0-9a-f]{64}$/u.test(hmacKey)) {
    throw new Error("The Update Control administrative HMAC key must be 64 lowercase hexadecimal characters.");
  }
  const raw = requireValue(env, "MCP_UPDATE_CONTROL_PUBLIC_URL");
  let publicUrl;
  try {
    publicUrl = new URL(raw);
  } catch {
    throw new Error("The public URL is invalid.");
  }
  const isRootOrigin = raw === publicUrl.origin || raw === `${publicUrl.origin}/`;
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.port ||
      publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || !isRootOrigin) {
    throw new Error("The public URL must be an HTTPS origin.");
  }
  return {
    operationId,
    endpoint: new URL(ADMIN_BOOTSTRAP_PATH, publicUrl.origin),
    hmacKey,
  };
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
    ADMIN_BOOTSTRAP_PATH,
    operationId,
    timestamp,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(hexBytes(hmacKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    asArrayBuffer(new TextEncoder().encode(canonical)),
  ));
  return `HMAC-SHA256 v1=${timestamp}.${toHex(signature)}`;
}

async function readBoundedJson(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("Admin-bootstrap response exceeded the configured size limit.");
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
        throw new Error("Admin-bootstrap response exceeded the configured size limit.");
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
    throw new Error("Admin-bootstrap endpoint returned invalid JSON.");
  }
}

async function requestJson(fetchImpl, settings, method) {
  const url = method === "GET" ? new URL(settings.endpoint) : settings.endpoint;
  if (method === "GET") url.searchParams.set("operationId", settings.operationId);
  const authorization = await createAuthorization(method, settings.operationId, settings.hmacKey);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify({ operationId: settings.operationId }) } : {}),
    });
  } catch {
    throw new Error("Admin-bootstrap request failed.");
  }
  return { response, payload: await readBoundedJson(response) };
}

function safeStatus(payload, operationId) {
  return payload && typeof payload === "object" && !Array.isArray(payload) &&
    payload.operationId === operationId && typeof payload.status === "string" &&
    VALID_STATUSES.has(payload.status) ? payload.status : null;
}

function safeError(payload) {
  const error = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.error : undefined;
  return typeof error === "string" && /^[a-z0-9_]{1,64}$/u.test(error) ? error : null;
}

export async function diagnoseAdminBootstrap({ env = process.env, fetchImpl = fetch } = {}) {
  const settings = readSettings(env, { requireConfirmation: false });
  const { response, payload } = await requestJson(fetchImpl, settings, "GET");
  return {
    operationId: settings.operationId,
    httpStatus: response.status,
    status: safeStatus(payload, settings.operationId),
    error: safeError(payload),
  };
}

export async function activateAdminBootstrap({ env = process.env, fetchImpl = fetch } = {}) {
  const settings = readSettings(env);
  const statusResult = await requestJson(fetchImpl, settings, "GET");
  const current = safeStatus(statusResult.payload, settings.operationId);
  if (statusResult.response.status !== 200 || !current) {
    throw new Error("Admin-bootstrap status is unavailable; no mutation was attempted.");
  }
  if (current === "ready" || current === "completed") {
    return { operationId: settings.operationId, status: current };
  }
  if (current === "expired") {
    throw new Error("Admin-bootstrap operation is expired. Use a new operation ID after explicit approval.");
  }
  const { response, payload } = await requestJson(fetchImpl, settings, "POST");
  const status = safeStatus(payload, settings.operationId);
  if (response.status === 200 && status === "ready") {
    return { operationId: settings.operationId, status };
  }
  throw new Error("Admin-bootstrap activation was rejected.");
}

async function main() {
  const mode = process.argv[2];
  try {
    if (mode === "diagnose") {
      const result = await diagnoseAdminBootstrap();
      process.stdout.write(`Admin bootstrap diagnosis: ${JSON.stringify(result)}\n`);
      return;
    }
    if (mode === "activate") {
      const result = await activateAdminBootstrap();
      process.stdout.write(`Admin bootstrap status: ${result.status}.\n`);
      return;
    }
    throw new Error("Expected mode: diagnose or activate.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected failure.";
    process.stderr.write(`Admin bootstrap stopped safely: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
