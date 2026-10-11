import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// This code never publishes, deploys, mutates Cloudflare or prints raw CLI output.
const FAILURE = "EDGE_STAGE_UPLOAD_CONFIG_MISMATCH";
const MAX_LOG_BYTES = 1024 * 1024;
const STAGED = "services/mcp-edge-gateway/.wrangler/inspection-bridge/";
const ALIAS_KEYS = ["./generated/mcp-tool-manifest.js", "../generated/mcp-tool-manifest.js"];

function matchesExpectedBridgePath(p, suffix) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return false;
  const normalized = p.replaceAll("\\", "/");
  return normalized.endsWith("/" + STAGED + suffix) &&
    path.posix.normalize(normalized) === normalized;
}

export function validateBridgeUploadConfig(canonical, bridge) {
  const deny = () => { throw new Error(FAILURE); };
  if (!canonical || !bridge || typeof canonical !== "object" ||
      typeof bridge !== "object" || Array.isArray(canonical) || Array.isArray(bridge)) deny();
  if (canonical.name !== "mcp-access-stack" || canonical.main !== "src/index.ts" ||
      canonical.alias !== undefined ||
      !Array.isArray(canonical.secrets?.required) ||
      !canonical.secrets.required.includes("MCP_CONTRACT_PREPARE_TOKEN") ||
      !Array.isArray(canonical.durable_objects?.bindings) ||
      canonical.durable_objects.bindings.length !== 1 ||
      canonical.durable_objects.bindings[0]?.name !== "MCP_SESSION" ||
      canonical.durable_objects.bindings[0]?.class_name !== "McpSession" ||
      !Array.isArray(canonical.migrations) || canonical.migrations.length === 0 ||
      !matchesExpectedBridgePath(bridge.main, "index.ts")) deny();
  const alias = bridge.alias;
  if (!alias || typeof alias !== "object" || Array.isArray(alias) ||
      Object.keys(alias).length !== ALIAS_KEYS.length) deny();
  const mainDir = path.dirname(bridge.main);
  const expectedManifest = path.join(mainDir, "mcp-tool-manifest.ts");
  if (!ALIAS_KEYS.every(k => alias[k] === expectedManifest)) deny();
  const { main: _canonicalMain, ...original } = canonical;
  const { main: _bridgeMain, alias: _alias, ...candidate } = bridge;
  if (!isDeepStrictEqual(original, candidate)) deny();
  return "CONFIG_PARITY_VERIFIED";
}

export function classifyUploadFailure(log) {
  // Return only fixed allowlisted categories; never expose the message.
  if (typeof log !== "string") return "unknown";
  if (/\b(?:worker\s+)?version\s+id:\s*[a-f0-9-]{36}\b/iu.test(log)) {
    return "receipt_marker_outcome_unknown";
  }
  // Wrangler prints informational binding/migration banners even when the
  // failure has another cause. Only classify explicit error lines; do not
  // infer causality from arbitrary words elsewhere in its full output.
  const failures = log.split(/\r?\n/u).filter(line =>
    /^\s*(?:✘\s*)?(?:\[ERROR\]\s*)?(?:Error(?:\s+\d+)?\s*:|✘\s*\[ERROR\]|##\[error\]|HTTP\s+(?:401|403|429)\b|Authentication error\s*:|--strict\s*:|Invalid configuration|Could not resolve|Cannot find module|connect\s+(?:ETIMEDOUT|ECONNRESET|ENOTFOUND))/iu.test(line)
  ).join("\n");
  if (/\b10211\b/u.test(failures) ||
      /(?:durable objects?|migration|sqlite class)[^\n]*(?:not supported|cannot|can't|failed|prohibited|requires? deploy)/iu.test(failures) ||
      /(?:not supported|cannot|can't|failed|prohibited)[^\n]*(?:durable objects?|migration|sqlite class)/iu.test(failures)) {
    return "durable_object_migration";
  }
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|authentication|invalid token|insufficient permissions|permission denied)\b/iu.test(failures)) {
    return "authorization_or_scope";
  }
  if (/\b(?:429|rate limit|too many requests)\b/iu.test(failures)) return "rate_limited";
  if (/(?:--strict|strict mode|configuration (?:mismatch|differs)|remote configuration|binding.+conflict)/iu.test(failures)) {
    return "remote_configuration_conflict";
  }
  if (/(?:invalid configuration|config(?:uration)? file|parse config)/iu.test(failures)) {
    return "configuration_invalid";
  }
  if (/(?:could not resolve|cannot find module|missing dependency|ERR_MODULE_NOT_FOUND)/iu.test(failures)) {
    return "missing_dependency";
  }
  if (/(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|network error|socket hang up|fetch failed)/iu.test(failures)) {
    return "network_or_timeout";
  }
  return "unknown";
}

export async function classifyUploadLogFile(file) {
  try {
    const size = (await stat(file)).size;
    if (size > MAX_LOG_BYTES) return "log_too_large";
    if (size === 0) return "log_empty";
    const contents = await readFile(file, "utf8");
    return classifyUploadFailure(contents);
  } catch {
    return "log_unavailable";
  }
}

async function cli() {
  const command = process.argv[2];
  const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  if (process.argv.length !== 3 || !["preflight", "diagnose"].includes(command)) {
    throw new Error("EDGE_STAGE_UPLOAD_MODE_INVALID");
  }
  if (command === "preflight") {
    let canonical, bridge;
    try {
      canonical = JSON.parse(await readFile(path.join(root, "services/mcp-edge-gateway/wrangler.jsonc"), "utf8"));
      bridge = JSON.parse(await readFile(path.join(root, STAGED + "wrangler.json"), "utf8"));
    } catch { throw new Error("EDGE_STAGE_UPLOAD_CONFIG_UNREADABLE"); }
    console.log("EDGE_STAGE_UPLOAD_" + validateBridgeUploadConfig(canonical, bridge));
    return;
  }
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const result = path.isAbsolute(runnerTemp)
    ? await classifyUploadLogFile(path.join(runnerTemp, "edge-beta84-stage-upload.log"))
    : "log_unavailable";
  console.log("EDGE_STAGE_UPLOAD_DIAGNOSTIC " + result + "; outcome_unknown; DO_NOT_RETRY");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    const allowed = ["EDGE_STAGE_UPLOAD_CONFIG_UNREADABLE", FAILURE, "EDGE_STAGE_UPLOAD_MODE_INVALID"];
    console.error(allowed.includes(error?.message) ? error.message : "EDGE_STAGE_UPLOAD_DIAGNOSTIC_UNAVAILABLE");
    process.exitCode = 1;
  });
}
