import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { QualifiedRunCommandInput } from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../../internal-types.js";
import { PathSecurity } from "../../path-security.js";
import {
  NativeCommandContextProbe,
  type CommandContextProbe,
} from "./context-probe.js";
import { classifyCommandExecution } from "./effect-risk-classifier.js";
import type {
  LimitedCommandContext,
  LimitedPackageMetadata,
  LimitedPackageScriptMetadata,
  LimitedWorkspaceMarker,
} from "./types.js";

const MAX_METADATA_FILE_BYTES = 1_000_000;
const MAX_ROOT_ENTRIES = 256;
const MAX_PACKAGE_SCRIPTS = 128;
const MAX_PACKAGE_SCRIPT_BYTES = 32_000;

const FIXED_MARKERS = new Map<string, LimitedWorkspaceMarker["kind"]>([
  ["package.json", "package-manifest"],
  ["package-lock.json", "package-lock"],
  ["pnpm-lock.yaml", "package-lock"],
  ["yarn.lock", "package-lock"],
  ["bun.lock", "package-lock"],
  ["bun.lockb", "package-lock"],
  ["deno.json", "project-manifest"],
  ["deno.jsonc", "project-manifest"],
  ["pyproject.toml", "project-manifest"],
  ["requirements.txt", "project-manifest"],
  ["Cargo.toml", "project-manifest"],
  ["go.mod", "project-manifest"],
  ["global.json", "project-manifest"],
  ["Directory.Build.props", "project-manifest"],
  ["AGENTS.md", "instruction"],
  ["CLAUDE.md", "instruction"],
  [".git", "repository"],
]);

export interface CommandContextCollector {
  collect(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
  ): Promise<LimitedCommandContext>;
}

export class LimitedCommandContextCollector implements CommandContextCollector {
  constructor(
    private readonly probe: CommandContextProbe = new NativeCommandContextProbe(),
  ) {}

  async collect(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
  ): Promise<LimitedCommandContext> {
    const security = new PathSecurity(workspace);
    const authorized = await security.authorizeExisting(
      input.cwd ?? ".",
      "directory",
      true,
    );
    const canonicalCwd = authorized.canonicalPath;
    const markers = await collectMarkers(canonicalCwd);
    const packageMetadata = await collectPackageMetadata(canonicalCwd, markers);
    const toolNames = determineToolNames(workspace, markers, packageMetadata);
    const [git, tools] = await Promise.all([
      this.probe.getGitContext(canonicalCwd),
      Promise.all(
        toolNames.map((name) => this.probe.probeTool(name, canonicalCwd)),
      ),
    ]);

    return {
      workspaceId: workspace.id,
      logicalCwd: authorized.logicalPath,
      absoluteCwd: canonicalCwd,
      platform: process.platform,
      architecture: process.arch,
      allowedShells: [...workspace.allowedShells],
      markers,
      ...(packageMetadata === undefined ? {} : { packageMetadata }),
      git,
      tools,
    };
  }
}

async function collectMarkers(cwd: string): Promise<LimitedWorkspaceMarker[]> {
  let entries;
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return [];
  }

  const selected = entries
    .filter((entry) =>
      isRelevantEntry(entry.name, entry.isFile(), entry.isDirectory()),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_ROOT_ENTRIES);

  const markers: LimitedWorkspaceMarker[] = [];
  for (const entry of selected) {
    const kind = markerKind(entry.name);
    if (!kind) continue;
    const fullPath = path.join(cwd, entry.name);
    if (entry.isDirectory()) {
      markers.push({ path: entry.name, kind });
      continue;
    }
    try {
      const metadata = await stat(fullPath);
      const marker: LimitedWorkspaceMarker = {
        path: entry.name,
        kind,
        sizeBytes: metadata.size,
      };
      if (metadata.size <= MAX_METADATA_FILE_BYTES) {
        marker.sha256 = createHash("sha256")
          .update(await readFile(fullPath))
          .digest("hex");
      }
      markers.push(marker);
    } catch {
      continue;
    }
  }
  return markers;
}

function isRelevantEntry(
  name: string,
  isFile: boolean,
  isDirectory: boolean,
): boolean {
  if (FIXED_MARKERS.has(name)) return isFile || isDirectory;
  if (!isFile) return false;
  return /\.(sln|csproj|fsproj|vbproj)$/iu.test(name);
}

function markerKind(name: string): LimitedWorkspaceMarker["kind"] | undefined {
  const fixed = FIXED_MARKERS.get(name);
  if (fixed) return fixed;
  if (/\.(sln|csproj|fsproj|vbproj)$/iu.test(name)) {
    return "project-manifest";
  }
  return undefined;
}

async function collectPackageMetadata(
  cwd: string,
  markers: LimitedWorkspaceMarker[],
): Promise<LimitedPackageMetadata | undefined> {
  const marker = markers.find((item) => item.path === "package.json");
  if (!marker || (marker.sizeBytes ?? 0) > MAX_METADATA_FILE_BYTES) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
      name?: unknown;
      packageManager?: unknown;
      scripts?: unknown;
    };
    const declaredPackageManager =
      typeof parsed.packageManager === "string" &&
      parsed.packageManager.length <= 200
        ? parsed.packageManager
        : undefined;
    const markerNames = new Set(markers.map((item) => item.path));
    const inferredPackageManager = packageManagerName(undefined, markerNames);
    return {
      ...(typeof parsed.name === "string" && parsed.name.length <= 200
        ? { name: parsed.name }
        : {}),
      ...(declaredPackageManager !== undefined
        ? { packageManager: declaredPackageManager }
        : inferredPackageManager !== undefined
          ? { packageManager: inferredPackageManager }
          : {}),
      scripts: collectPackageScripts(parsed.scripts),
    };
  } catch {
    return undefined;
  }
}

function collectPackageScripts(value: unknown): LimitedPackageScriptMetadata[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const shell = process.platform === "win32" ? "cmd" : "git-bash";
  return Object.entries(value)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        entry[0].length <= 100 &&
        typeof entry[1] === "string" &&
        Buffer.byteLength(entry[1], "utf8") <= MAX_PACKAGE_SCRIPT_BYTES,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_PACKAGE_SCRIPTS)
    .map(([name, command]) => {
      const classification = classifyCommandExecution(shell, {
        kind: "script",
        script: command,
      });
      return {
        name,
        commandSha256: createHash("sha256").update(command).digest("hex"),
        effectClass: classification.effectClass,
        riskClass: classification.riskClass,
      };
    });
}

function determineToolNames(
  workspace: ResolvedWorkspace,
  markers: LimitedWorkspaceMarker[],
  packageMetadata: LimitedPackageMetadata | undefined,
): string[] {
  const names = new Set<string>(["git", ...workspace.allowedShells]);
  const markerNames = new Set(markers.map((marker) => marker.path));
  if (markerNames.has("package.json")) {
    const packageManager = packageManagerName(
      packageMetadata?.packageManager,
      markerNames,
    );
    if (packageManager) names.add(packageManager);
    names.add("node");
  }
  if (
    [...markerNames].some((name) =>
      /\.(sln|csproj|fsproj|vbproj)$/iu.test(name),
    )
  ) {
    names.add("dotnet");
  }
  if (markerNames.has("Cargo.toml")) names.add("cargo");
  if (markerNames.has("go.mod")) names.add("go");
  if (markerNames.has("pyproject.toml") || markerNames.has("requirements.txt")) {
    names.add("python");
  }
  return [...names].sort();
}

function packageManagerName(
  packageManager: string | undefined,
  markers: Set<string>,
): "npm" | "pnpm" | "yarn" | "bun" | undefined {
  const declared = packageManager?.split("@", 1)[0]?.toLowerCase();
  if (declared !== undefined) {
    if (
      declared === "npm" ||
      declared === "pnpm" ||
      declared === "yarn" ||
      declared === "bun"
    ) {
      return declared;
    }
    return undefined;
  }
  if (markers.has("pnpm-lock.yaml")) return "pnpm";
  if (markers.has("yarn.lock")) return "yarn";
  if (markers.has("bun.lock") || markers.has("bun.lockb")) return "bun";
  return "npm";
}
