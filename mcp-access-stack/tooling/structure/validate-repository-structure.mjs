import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_DIRECTORIES = [
  "services/browser-worker",
  "services/browser-worker/config",
  "services/browser-worker/controllers",
  "services/browser-worker/domain",
  "services/browser-worker/drivers/direct",
  "services/browser-worker/infrastructure",
  "services/browser-worker/policies",
  "services/browser-worker/services",
  "services/browser-worker/test/unit",
  "services/browser-worker/test/integration",
  "services/browser-worker/test/e2e",
  "services/mcp-gateway",
  "services/mcp-gateway/src/actions",
  "services/mcp-gateway/src/actions/console",
  "services/mcp-gateway/src/relay",
  "services/mcp-gateway/src/auth",
  "services/mcp-gateway/src/browser",
  "services/mcp-gateway/src/http",
  "services/mcp-gateway/src/mcp",
  "services/mcp-gateway/test/unit",
  "services/mcp-gateway/test/integration",
  "services/mcp-gateway/test/e2e",
  "services/mcp-gateway/test/support",
  "services/workspace-agent",
  "services/workspace-agent/src/validation",
  "services/workspace-agent/src/filesystem",
  "services/workspace-agent/src/git",
  "services/workspace-agent/src/shell",
  "services/workspace-agent/src/connection",
  "services/workspace-agent/test/unit",
  "services/workspace-agent/test/integration",
  "services/workspace-agent/test/e2e",
  "services/workspace-agent/test/support",
  "packages/mcp-core",
  "operations/runtime",
  "operations/browser",
  "operations/gpt-actions",
  "operations/inspector",
  "operations/validation",
  "deploy/docker",
  "deploy/windows",
  "tooling/benchmarks/browser",
  "tooling/benchmarks/mcp",
  "tooling/smoke/browser",
  "docs/architecture",
  "docs/integrations",
  "docs/operations",
  "docs/security",
];

const REQUIRED_FILES = [
  "docs/architecture/REPOSITORY_STRUCTURE.md",
  "config/gpt-only-production.example.json",
  "operations/runtime/Initialize-GptOnlyProduction.ps1",
  "docs/integrations/CHATGPT_INTEGRATION.md",
  "services/README.md",
  "packages/README.md",
  "operations/README.md",
  "deploy/README.md",
  "tooling/README.md",
  "tooling/smoke/README.md",
  "deploy/windows/Install-McpAccessStack.ps1",
  "deploy/windows/Update-McpAccessStack.ps1",
  "services/browser-worker/server.ts",
  "jest.config.ts",
  "jest.preset.ts",
  "tsconfig.jest.json",
  "packages/mcp-core/jest.config.ts",
  "services/browser-worker/jest.config.ts",
  "services/mcp-gateway/jest.config.ts",
  "services/mcp-gateway/test/README.md",
  "services/workspace-agent/jest.config.ts",
  "services/workspace-agent/test/README.md",
  "services/browser-worker/test/README.md",
];

const FORBIDDEN_ROOT_DIRECTORIES = [
  "apps",
  "scripts",
  "docker",
  "docker-config",
  "benchmarks",
  "refactor",
];

const FORBIDDEN_BROWSER_WORKER_ROOT_ENTRIES = [
  "app.ts",
  "audit-log.ts",
  "browser-advanced-driver.ts",
  "browser-driver.ts",
  "browser-driver-router.ts",
  "browser-operation-mode.ts",
  "browser-operation-policy.ts",
  "browser-operation-queue.ts",
  "browser-readiness.ts",
  "browser-runtime.ts",
  "browser-session-model.ts",
  "cli",
  "config.ts",
  "confirmation-registry.ts",
  "navigation-cache.ts",
  "playwright-mcp-session.ts",
  "session-registry.ts",
  "tab-registry.ts",
];

const FORBIDDEN_MCP_GATEWAY_ROOT_ENTRIES = [
  "agent-relay.ts",
  "relay-workspace-executor.ts",
  "gpt-actions.ts",
  "gpt-actions-openapi.ts",
  "gpt-action-console.ts",
  "auth.ts",
  "oauth-owner.ts",
  "owner-oauth-mount.ts",
  "browser-worker-client.ts",
  "mcp-server.ts",
  "chatgpt-tools-list.ts",
];

const FORBIDDEN_WORKSPACE_AGENT_ROOT_ENTRIES = [
  "file-service.ts",
  "git-service.ts",
  "shell-service.ts",
  "agent-connection.ts",
  "command-risk.ts",
  "command-confirmation.ts",
  "text-encoding.ts",
  "validation-service.ts",
  "validation-process-runner.ts",
  "validation-diff-check.ts",
  "validation-legacy-format.ts",
  "validation-legacy-compat.ts",
  "validation-secret-scan.ts",
  "validation-text-format.ts",
];

const FORBIDDEN_SERVICE_TOOLING_FILES = [
  "services/browser-worker/browser-advanced-smoke.ts",
  "services/browser-worker/browser-smoke.ts",
  "services/mcp-gateway/src/browser-worker-advanced-smoke.ts",
  "services/mcp-gateway/src/mcp-browser-smoke-client.ts",
  "services/mcp-gateway/src/playwright-cli-session.ts",
];

const EXPECTED_WORKSPACES = ["services/*", "packages/*"];
const LEGACY_PATHS = [
  "apps/browser-worker",
  "apps/local-agent",
  "apps/remote-mcp-gateway",
  "apps/vscode-extension",
  "integrations/vscode-extension",
  "packages/shared",
  "scripts/gpt-only-supervisor.mjs",
  "scripts/gpt-mcp-proxy.mjs",
  "refactor/gpt-only/start-production.mjs",
  "docker-config/",
];

export function validateRepositoryStructure(root = process.cwd()) {
  const issues = [];
  for (const directory of REQUIRED_DIRECTORIES) {
    if (!existsSync(path.join(root, directory))) issues.push(`Missing directory: ${directory}`);
  }
  for (const file of REQUIRED_FILES) {
    if (!existsSync(path.join(root, file))) issues.push(`Missing integration guide: ${file}`);
  }
  for (const directory of FORBIDDEN_ROOT_DIRECTORIES) {
    if (existsSync(path.join(root, directory))) issues.push(`Legacy root directory still exists: ${directory}`);
  }
  for (const entry of FORBIDDEN_BROWSER_WORKER_ROOT_ENTRIES) {
    if (existsSync(path.join(root, "services/browser-worker", entry))) {
      issues.push(`Browser Worker root contains a legacy entry: ${entry}`);
    }
  }
  const browserWorkerRoot = path.join(root, "services/browser-worker");
  for (const file of listTextFiles(browserWorkerRoot)) {
    const relative = path.relative(browserWorkerRoot, file).replaceAll("\\", "/");
    if (relative.endsWith(".test.ts") && !relative.startsWith("test/")) {
      issues.push(`Browser Worker test must live under test/: ${relative}`);
    }
  }
  const mcpGatewaySourceRoot = path.join(root, "services/mcp-gateway/src");
  for (const entry of FORBIDDEN_MCP_GATEWAY_ROOT_ENTRIES) {
    if (existsSync(path.join(mcpGatewaySourceRoot, entry))) {
      issues.push(`MCP Gateway source root contains a legacy entry: ${entry}`);
    }
  }
  const mcpGatewayTestRoot = path.join(root, "services/mcp-gateway/test");
  for (const file of listTextFiles(mcpGatewayTestRoot)) {
    const relative = path.relative(mcpGatewayTestRoot, file).replaceAll("\\", "/");
    if (
      relative.endsWith(".test.ts") &&
      !["unit/", "integration/", "e2e/"].some((prefix) => relative.startsWith(prefix))
    ) {
      issues.push(`MCP Gateway test must live under unit/, integration/ or e2e/: ${relative}`);
    }
  }
  const workspaceAgentSourceRoot = path.join(root, "services/workspace-agent/src");
  for (const entry of FORBIDDEN_WORKSPACE_AGENT_ROOT_ENTRIES) {
    if (existsSync(path.join(workspaceAgentSourceRoot, entry))) {
      issues.push(`Workspace Agent source root contains legacy validation entry: ${entry}`);
    }
  }
  const workspaceAgentTestRoot = path.join(root, "services/workspace-agent/test");
  for (const file of listTextFiles(workspaceAgentTestRoot)) {
    const relative = path.relative(workspaceAgentTestRoot, file).replaceAll("\\", "/");
    if (
      relative.endsWith(".test.ts") &&
      !["unit/", "integration/", "e2e/"].some((prefix) => relative.startsWith(prefix))
    ) {
      issues.push(`Workspace Agent test must live under unit/, integration/ or e2e/: ${relative}`);
    }
  }
  for (const file of FORBIDDEN_SERVICE_TOOLING_FILES) {
    if (existsSync(path.join(root, file))) {
      issues.push(`Service-local tooling file must live under tooling/: ${file}`);
    }
  }

  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (JSON.stringify(packageJson.workspaces) !== JSON.stringify(EXPECTED_WORKSPACES)) {
    issues.push(`Unexpected npm workspaces: ${JSON.stringify(packageJson.workspaces)}`);
  }

  const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const legacyWorkspace of [
    "apps/browser-worker",
    "apps/local-agent",
    "apps/remote-mcp-gateway",
    "apps/vscode-extension",
    "integrations/vscode-extension",
    "packages/shared",
  ]) {
    if (packageLock.packages?.[legacyWorkspace]) {
      issues.push(`Legacy workspace remains in package-lock.json: ${legacyWorkspace}`);
    }
  }

  validateServiceBoundaries(root, issues);
  validateDockerCopies(root, "deploy/docker/gateway.Dockerfile", issues);
  validateDockerCopies(root, "deploy/docker/proxy.Dockerfile", issues);
  validateLegacyReferences(root, issues);

  return {
    passed: issues.length === 0,
    issues,
    modules: REQUIRED_DIRECTORIES.length,
    guides: REQUIRED_FILES.length,
  };
}

export function validateServiceBoundaries(root, issues) {
  const servicesRoot = path.resolve(root, "services");
  const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/gu;
  for (const entry of readdirSync(servicesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const serviceRoot = path.join(servicesRoot, entry.name);
    const sourceRoot = path.join(serviceRoot, "src");
    for (const file of listTextFiles(sourceRoot)) {
      if (!file.endsWith(".ts")) continue;
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(importPattern)) {
        const specifier = match[1];
        if (!specifier?.startsWith(".")) continue;
        const target = path.resolve(path.dirname(file), specifier);
        const insideCurrentService =
          target === serviceRoot || target.startsWith(`${serviceRoot}${path.sep}`);
        const insideAnotherService =
          target === servicesRoot || target.startsWith(`${servicesRoot}${path.sep}`);
        if (!insideCurrentService && insideAnotherService) {
          issues.push(
            `${path.relative(root, file).replaceAll("\\", "/")} imports another service internal: ${specifier}`,
          );
        }
      }
    }
  }
}

function validateDockerCopies(root, dockerfilePath, issues) {
  const content = readFileSync(path.join(root, dockerfilePath), "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("COPY ") || trimmed.includes("--from=")) continue;
    const tokens = trimmed.split(/\s+/u).slice(1);
    for (const source of tokens.slice(0, -1)) {
      if (source.startsWith("--")) continue;
      const normalized = source.replace(/\/$/u, "");
      if (!existsSync(path.join(root, normalized))) {
        issues.push(`${dockerfilePath} references missing COPY source: ${source}`);
      }
    }
  }
}

function validateLegacyReferences(root, issues) {
  const roots = [
    "package.json",
    "tsconfig.json",
    "jest.config.ts",
    "jest.preset.ts",
    "services",
    "integrations",
    "packages",
    "operations",
    "deploy",
    "tooling",
  ];
  for (const relativeRoot of roots) {
    const absolute = path.join(root, relativeRoot);
    const files = existsSync(absolute) && path.extname(absolute)
      ? [absolute]
      : listTextFiles(absolute);
    for (const file of files) {
      if (path.resolve(file) === path.resolve(root, "tooling/structure/validate-repository-structure.mjs")) {
        continue;
      }
      const content = readFileSync(file, "utf8").replaceAll("\\", "/");
      for (const legacyPath of LEGACY_PATHS) {
        if (content.includes(legacyPath)) {
          issues.push(
            `${path.relative(root, file).replaceAll("\\", "/")} references legacy path ${legacyPath}`,
          );
        }
      }
    }
  }
}

function listTextFiles(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (["dist", "node_modules", "runtime"].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (/\.(?:ts|js|mjs|cjs|json|jsonc|ps1|ya?ml|md|Dockerfile)$/u.test(entry.name)) {
        result.push(absolute);
      }
    }
  }
  return result;
}

async function main() {
  const result = validateRepositoryStructure();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
