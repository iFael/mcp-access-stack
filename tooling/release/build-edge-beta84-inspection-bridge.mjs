import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Reproducible, code-only build. This is NOT a release/deploy workflow.
export const BETA84_COMMIT = "d60ff2f4a8f2b17f2425945aedc9e76ba1c17cb0";
export const BETA84_MANIFEST_BLOB = "cc5fb34afe6d0e9dc1864d3c830eb35340ae6be1";
export const BETA84_REVISION = "a35a966fee8333618c3018e2b621196a64860dc3d6d578a6d4173d09ee984e59";
export const MAIN_AT_GATE_REVISION = "c73274d7f1d3d7b9b35a9172eeb1d19b17cd998b564ff05026f3e3b5d26c4949";
const MANIFEST_PATH = "services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts";
const SOURCE_PATH = "services/mcp-edge-gateway/src/index.ts";
const BRIDGE_ONLY_BLOCKED_ROUTES = [
  "/_internal/contract-rollout/bootstrap",
  "/_internal/contract-rollout/prepare",
];

export function bridgeEntrypointSource(canonicalEntry) {
  const modulePath = resolve(canonicalEntry).replaceAll("\\", "/");
  return [
    `import canonicalWorker, { McpSession } from ${JSON.stringify(modulePath)};`,
    "export { McpSession };",
    "export default {",
    "  async fetch(request, env, ctx) {",
    "    const pathname = new URL(request.url).pathname;",
    `    if (${JSON.stringify(BRIDGE_ONLY_BLOCKED_ROUTES)}.includes(pathname)) {`,
    '      return new Response(JSON.stringify({ error: "bridge_operation_unavailable" }), {',
    '        status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" },',
    "      });",
    "    }",
    "    return canonicalWorker.fetch(request, env, ctx);",
    "  },",
    "};",
    "",
  ].join("\n");
}
const RELATIVE_IMPORTS = [
  "./generated/mcp-tool-manifest.js",
  "../generated/mcp-tool-manifest.js",
];

export function extractRevision(source) {
  const match = /"contractRevision":\s*"([0-9a-f]{64})"/u.exec(source);
  if (!match) throw new Error("Bridge manifest lacks an exact contract revision.");
  return match[1];
}

export function verifyFrozenManifest(source, blobSha) {
  if (blobSha !== BETA84_MANIFEST_BLOB ||
      !source.startsWith("// GENERATED FILE. DO NOT EDIT.") ||
      extractRevision(source) !== BETA84_REVISION) {
    throw new Error("Historical beta.84 manifest mismatch; refusing bridge.");
  }
  return BETA84_REVISION;
}

export function makeBridgeConfig(canonical, root, manifestPath) {
  if (canonical.name !== "mcp-access-stack" ||
      canonical.main !== "src/index.ts" ||
      canonical.alias !== undefined ||
      canonical.secrets?.required?.join(",") !== "MCP_CONTRACT_PREPARE_TOKEN" ||
      canonical.durable_objects?.bindings?.length !== 1 ||
      canonical.durable_objects.bindings[0]?.name !== "MCP_SESSION" ||
      canonical.durable_objects.bindings[0]?.class_name !== "McpSession") {
    throw new Error("Canonical Worker configuration drift; refusing bridge.");
  }
  return {
    ...canonical,
    // Alias only in the isolated dry-run config, never in canonical wrangler.jsonc.
    main: join(root, "services/mcp-edge-gateway/.wrangler/inspection-bridge/index.ts"),
    alias: Object.fromEntries(
      RELATIVE_IMPORTS.map(key => [key, resolve(manifestPath)]),
    ),
  };
}

export async function prepareBridge({ root, readHistorical, hashHistorical }) {
  const source = readHistorical(BETA84_COMMIT, MANIFEST_PATH);
  verifyFrozenManifest(source, hashHistorical(source));
  const edgeDir = join(root, "services/mcp-edge-gateway");
  const original = JSON.parse(await readFile(join(edgeDir, "wrangler.jsonc"), "utf8"));
  const mainManifest = await readFile(join(root, MANIFEST_PATH), "utf8");
  if (extractRevision(mainManifest) !== MAIN_AT_GATE_REVISION) {
    throw new Error("Canonical manifest changed; bridge requires a fresh review.");
  }
  const staging = join(edgeDir, ".wrangler/inspection-bridge");
  const manifestPath = join(staging, "mcp-tool-manifest.ts");
  const config = makeBridgeConfig(original, root, manifestPath);
  await mkdir(staging, { recursive: true });
  await writeFile(manifestPath, source, { flag: "w" });
  await writeFile(join(staging, "index.ts"), bridgeEntrypointSource(resolve(root, SOURCE_PATH)), "utf8");
  await writeFile(join(staging, "wrangler.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  return { staging, configPath: join(staging, "wrangler.json"), revision: BETA84_REVISION };
}

function runGit(root, args, input) {
  return execFileSync("git", args, {
    cwd: root, input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Emit only fixed diagnostic categories: Wrangler stdout/stderr can contain
// environment details and must never be surfaced verbatim in public CI logs.
export function classifyWranglerDryRunFailure(result) {
  if (result.error?.code === "ETIMEDOUT") return "timeout";
  if (result.error?.code === "ENOBUFS") return "output_limit";
  const output = String(result.stderr ?? "") + "\n" + String(result.stdout ?? "");
  if (/Could not resolve|Cannot find module|ERR_MODULE_NOT_FOUND/u.test(output)) {
    return "missing_module_or_import";
  }
  if (/Invalid configuration|Configuration file|config\.json/u.test(output)) {
    return "configuration_error";
  }
  if (result.error) return "process_error";
  return "unknown";
}

async function dryRunBridge(root, paths) {
  const outdir = join(paths.staging, "bundle");
  const result = spawnSync(process.execPath, [
    join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy",
    "--cwd", root, "--config", paths.configPath, "--dry-run", "--outdir", outdir,
  ], { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error("Bridge Wrangler dry-run failed (" + classifyWranglerDryRunFailure(result) + "); no deploy was attempted.");
  }
  const jsFiles = (await readdir(outdir)).filter(file => file.endsWith(".js"));
  if (jsFiles.length === 0) throw new Error("Bridge dry-run produced no JavaScript bundle.");
  const bundle = (await Promise.all(jsFiles.map(file => readFile(join(outdir, file), "utf8")))).join("\n");
  if (!bundle.includes(BETA84_REVISION) || bundle.includes(MAIN_AT_GATE_REVISION)) {
    throw new Error("Bridge bundle does not isolate the exact beta.84 catalog.");
  }
  return { bundleVerified: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!["--prepare", "--dry-run"].includes(process.argv[2]) || process.argv.length !== 3) {
    throw new Error("Only --prepare or --dry-run are supported (never deploy).");
  }
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const paths = await prepareBridge({
    root,
    readHistorical: (sha, path) => runGit(root, ["show", sha + ":" + path]),
    hashHistorical: source => runGit(root, ["hash-object", "--stdin"], source).trim(),
  });
  if (process.argv[2] === "--dry-run") await dryRunBridge(root, paths);
  process.stdout.write(JSON.stringify({
    status: process.argv[2] === "--dry-run" ? "bundle_dry_run_verified" : "prepared_locally",
    contractRevision: paths.revision,
    canonicalManifestIntact: true,
    networkMutation: false,
  }) + "\n");
}
