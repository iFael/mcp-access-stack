import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IMPACT_KEYS = [
  "shared",
  "edgeProtocol",
  "workspaceAgent",
  "mcpGateway",
  "edgeGateway",
  "browserWorker",
  "windowsRuntime",
  "dockerGateway",
  "dockerBrowser",
  "dockerProxy",
  "operationsTooling",
  "rootBroad",
];

const ROOT_BROAD_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.jest.json",
  "jest.config.ts",
  "jest.preset.ts",
]);

export function classifyChangedPaths(changedPaths) {
  const normalized = [...new Set(changedPaths.map(normalizePath).filter(Boolean))];
  const impact = emptyImpact(normalized);

  if (normalized.length === 0) {
    applyBroadImpact(impact);
    return impact;
  }

  const nonDocs = normalized.filter((filePath) => !isDocumentationPath(filePath));
  if (nonDocs.length === 0) {
    impact.docsOnly = true;
    return impact;
  }

  for (const repositoryPath of nonDocs) {
    classifyPath(repositoryPath, impact);
  }

  expandDependencies(impact);
  impact.docsOnly = false;
  return impact;
}

export function resolveChangedPaths(baseSha, headSha, cwd = process.cwd()) {
  if (!baseSha || !headSha) {
    throw new Error("Both base and head SHA are required.");
  }
  const stdout = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${baseSha}...${headSha}`],
    { cwd, encoding: "utf8", windowsHide: true },
  );
  return stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

export function writeGithubOutputs(result, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = [
    ...IMPACT_KEYS.map((key) => `${key}=${result[key] ? "true" : "false"}`),
    `docsOnly=${result.docsOnly ? "true" : "false"}`,
    `resolverFailed=${result.resolverFailed ? "true" : "false"}`,
    `changedPathsJson=${JSON.stringify(result.changedPaths)}`,
  ];
  appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function classifyPath(repositoryPath, impact) {
  if (repositoryPath.startsWith(".github/")) {
    applyBroadImpact(impact);
    return;
  }

  const projectPath = stripProjectPrefix(repositoryPath);
  if (projectPath === null) {
    applyBroadImpact(impact);
    return;
  }

  if (ROOT_BROAD_FILES.has(projectPath)) {
    applyBroadImpact(impact);
    return;
  }
  if (projectPath.startsWith("packages/mcp-core/")) {
    impact.shared = true;
    return;
  }
  if (projectPath.startsWith("packages/edge-protocol/")) {
    impact.edgeProtocol = true;
    return;
  }
  if (projectPath.startsWith("services/workspace-agent/")) {
    impact.workspaceAgent = true;
    return;
  }
  if (projectPath.startsWith("services/mcp-gateway/")) {
    impact.mcpGateway = true;
    return;
  }
  if (projectPath.startsWith("services/mcp-edge-gateway/")) {
    impact.edgeGateway = true;
    return;
  }
  if (projectPath.startsWith("services/browser-worker/")) {
    impact.browserWorker = true;
    return;
  }
  if (projectPath.startsWith("deploy/windows/")) {
    impact.windowsRuntime = true;
    impact.operationsTooling = true;
    return;
  }
  if (projectPath === "deploy/docker/gateway.Dockerfile") {
    impact.dockerGateway = true;
    impact.operationsTooling = true;
    return;
  }
  if (projectPath === "deploy/remote/browser-worker.Dockerfile") {
    impact.dockerBrowser = true;
    impact.operationsTooling = true;
    return;
  }
  if (projectPath === "deploy/docker/proxy.Dockerfile") {
    impact.dockerProxy = true;
    impact.operationsTooling = true;
    return;
  }
  if (projectPath === "operations/runtime/gpt-mcp-proxy.mjs") {
    impact.dockerProxy = true;
    impact.operationsTooling = true;
    return;
  }
  if (
    projectPath.startsWith("deploy/") ||
    projectPath.startsWith("operations/") ||
    projectPath.startsWith("tooling/") ||
    projectPath.startsWith("config/")
  ) {
    impact.operationsTooling = true;
    return;
  }

  applyBroadImpact(impact);
}

function expandDependencies(impact) {
  if (impact.rootBroad) return;

  if (impact.shared) {
    impact.workspaceAgent = true;
    impact.mcpGateway = true;
    impact.browserWorker = true;
    impact.windowsRuntime = true;
    impact.dockerGateway = true;
    impact.dockerBrowser = true;
  }
  if (impact.edgeProtocol) {
    impact.mcpGateway = true;
    impact.edgeGateway = true;
    impact.windowsRuntime = true;
    impact.dockerGateway = true;
  }
  if (impact.workspaceAgent) {
    impact.mcpGateway = true;
    impact.windowsRuntime = true;
    impact.dockerGateway = true;
  }
  if (impact.mcpGateway) {
    impact.windowsRuntime = true;
    impact.dockerGateway = true;
  }
  if (impact.browserWorker) {
    impact.dockerBrowser = true;
  }
}

function applyBroadImpact(impact) {
  for (const key of IMPACT_KEYS) impact[key] = true;
  impact.docsOnly = false;
}

function emptyImpact(changedPaths) {
  return {
    ...Object.fromEntries(IMPACT_KEYS.map((key) => [key, false])),
    docsOnly: false,
    resolverFailed: false,
    changedPaths,
  };
}

function normalizePath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

function stripProjectPrefix(repositoryPath) {
  if (repositoryPath === "mcp-access-stack") return "";
  if (!repositoryPath.startsWith("mcp-access-stack/")) return null;
  return repositoryPath.slice("mcp-access-stack/".length);
}

function isDocumentationPath(repositoryPath) {
  if (repositoryPath.endsWith(".md")) return true;
  const projectPath = stripProjectPrefix(repositoryPath);
  return projectPath?.startsWith("docs/") ?? false;
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    options.set(name, value);
    index += 1;
  }
  return options;
}

function runCli() {
  const args = parseArguments(process.argv.slice(2));
  const baseSha = args.get("base");
  const headSha = args.get("head");
  let result;
  try {
    result = classifyChangedPaths(resolveChangedPaths(baseSha, headSha));
  } catch (error) {
    result = classifyChangedPaths(["mcp-access-stack/__resolver_failure__"]);
    result.resolverFailed = true;
    result.resolverError = error instanceof Error ? error.message : String(error);
  }
  writeGithubOutputs(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli();
}
