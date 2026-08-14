import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ConfirmationMode,
  PermissionProfile,
  WorkspaceKind,
  WorkspaceLimits,
} from "@vs-code-gpt/shared";

export const defaultLimits: WorkspaceLimits = {
  maxFileBytes: 64_000,
  maxSearchResults: 100,
  maxSearchSnippetBytes: 20_000,
  maxDiffBytes: 500_000,
  maxListedFiles: 500,
};

export interface FixtureOptions {
  profile?: PermissionProfile;
  confirmationMode?: ConfirmationMode;
  workspaceKind?: WorkspaceKind;
  allowedRoots?: string[];
  blockedGlobs?: string[];
  limits?: Partial<WorkspaceLimits>;
  enabled?: boolean;
}

export interface Fixture {
  basePath: string;
  workspacePath: string;
  policyPath: string;
  auditPath: string;
  cleanup(): Promise<void>;
}

export async function createFixture(
  options: FixtureOptions = {},
): Promise<Fixture> {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "vs-code-gpt-test-"));
  const workspacePath = path.join(basePath, "workspace");
  const auditPath = path.join(basePath, "audit");
  const policyPath = path.join(basePath, "policy.json");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(auditPath, { recursive: true });
  process.env.VS_CODE_GPT_DATA_DIR = auditPath;
  await writePolicy(policyPath, [
    makeWorkspacePolicy(workspacePath, options),
  ]);

  return {
    basePath,
    workspacePath,
    policyPath,
    auditPath,
    async cleanup() {
      await rm(basePath, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      delete process.env.VS_CODE_GPT_DATA_DIR;
    },
  };
}

export function makeWorkspacePolicy(
  workspacePath: string,
  options: FixtureOptions = {},
): Record<string, unknown> {
  return {
    id: "test",
    name: "Test Workspace",
    rootPath: workspacePath,
    ...(options.workspaceKind === undefined ? {} : { workspaceKind: options.workspaceKind }),
    enabled: options.enabled ?? true,
    permissionProfile: options.profile ?? "planning-readonly",
    ...(options.confirmationMode === undefined
      ? {}
      : { confirmationMode: options.confirmationMode }),
    allowedRoots: options.allowedRoots ?? ["."],
    blockedGlobs: options.blockedGlobs ?? [],
    limits: { ...defaultLimits, ...options.limits },
    allowWrites: [".codex/PLANNER_HANDOFF.md"],
  };
}

export async function writePolicy(
  policyPath: string,
  workspaces: Record<string, unknown>[],
): Promise<void> {
  await writeFile(
    policyPath,
    JSON.stringify({ version: 1, workspaces }, null, 2),
    "utf8",
  );
}

export async function writeWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  contents: string | Buffer,
): Promise<void> {
  const absolutePath = path.join(workspacePath, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

export function git(workspacePath: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: workspacePath,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function initializeGitRepository(workspacePath: string): void {
  git(workspacePath, ["init"]);
  git(workspacePath, ["config", "user.email", "tests@example.com"]);
  git(workspacePath, ["config", "user.name", "VS Code GPT Tests"]);
}
