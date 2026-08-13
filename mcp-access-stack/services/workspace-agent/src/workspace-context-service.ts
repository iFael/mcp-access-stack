import { access, readdir } from "node:fs/promises";
import path from "node:path";
import {
  abortSignalError,
  type GetWorkspaceContextResult,
  type SkillSummary,
} from "@vs-code-gpt/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedWorkspace } from "./internal-types.js";
import { PathSecurity } from "./path-security.js";

const execFileAsync = promisify(execFile);

const ROOT_INSTRUCTION_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export async function buildWorkspaceContext(
  workspace: ResolvedWorkspace,
  root = ".",
  signal?: AbortSignal,
): Promise<GetWorkspaceContextResult> {
  throwIfAborted(signal);
  const security = new PathSecurity(workspace);
  const authorized = await security.authorizeExisting(root, "directory", true);
  throwIfAborted(signal);
  const rootPath = authorized.canonicalPath;
  const logicalRoot = authorized.logicalPath;
  const instructionFiles = await discoverRootInstructionFiles(rootPath, logicalRoot, signal);
  const availableInstructionFiles = await discoverNestedInstructionFiles(rootPath, logicalRoot, signal);
  const skills = [
    ...(await discoverProjectSkills(
      path.join(rootPath, ".cursor", "skills"),
      workspace.canonicalRootPath,
      "project-cursor",
      signal,
    )),
    ...(await discoverProjectSkills(
      path.join(rootPath, ".pi", "skills"),
      workspace.canonicalRootPath,
      "project-pi",
      signal,
    )),
  ];
  const git = await readGitWorktreeHint(rootPath, signal);
  throwIfAborted(signal);

  return {
    workspaceId: workspace.id,
    rootPath: logicalRoot,
    instructionFiles,
    availableInstructionFiles,
    skills,
    git,
  };
}

async function discoverRootInstructionFiles(
  rootPath: string,
  logicalRoot: string,
  signal?: AbortSignal,
) {
  const found: GetWorkspaceContextResult["instructionFiles"] = [];
  const seen = new Set<string>();
  for (const name of ROOT_INSTRUCTION_NAMES) {
    throwIfAborted(signal);
    const key = name.toUpperCase();
    if (seen.has(key)) {
      continue;
    }
    const absolutePath = path.join(rootPath, name);
    if (await pathExists(absolutePath, signal)) {
      seen.add(key);
      found.push({ name, path: joinLogical(logicalRoot, name), exists: true });
    }
  }
  return found;
}

async function discoverNestedInstructionFiles(
  rootPath: string,
  logicalRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const matches: string[] = [];
  const queue = [rootPath];
  const maxFiles = 40;

  while (queue.length > 0 && matches.length < maxFiles) {
    throwIfAborted(signal);
    const current = queue.shift();
    if (!current) {
      break;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
      throwIfAborted(signal);
    } catch (error) {
      if (signal?.aborted) {
        throw abortSignalError(signal, "Workspace context discovery was cancelled.");
      }
      continue;
    }
    for (const entry of entries) {
      throwIfAborted(signal);
      if (matches.length >= maxFiles) {
        break;
      }
      if (shouldSkipContextDirectory(entry.name)) {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name.toUpperCase() === "AGENTS.MD" || entry.name.toUpperCase() === "CLAUDE.MD")
      ) {
        const relative = path.relative(rootPath, absolutePath).split(path.sep).join("/");
        if (relative !== ROOT_INSTRUCTION_NAMES.find((n) => n.toUpperCase() === entry.name.toUpperCase())) {
          matches.push(joinLogical(logicalRoot, relative));
        }
      }
    }
  }

  throwIfAborted(signal);
  return matches.sort();
}

async function discoverProjectSkills(
  skillsRoot: string,
  workspaceRoot: string,
  source: SkillSummary["source"] = "project-cursor",
  signal?: AbortSignal,
): Promise<SkillSummary[]> {
  throwIfAborted(signal);
  if (!(await pathExists(skillsRoot, signal))) {
    return [];
  }
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  throwIfAborted(signal);
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    if (!entry.isDirectory()) {
      continue;
    }
    const absoluteSkillFile = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!(await pathExists(absoluteSkillFile, signal))) {
      continue;
    }
    const relativeSkillFile = path
      .relative(workspaceRoot, absoluteSkillFile)
      .split(path.sep)
      .join("/");
    if (relativeSkillFile.startsWith("..")) {
      continue;
    }
    skills.push({
      name: entry.name,
      skillFilePath: relativeSkillFile,
      source,
    });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

async function readGitWorktreeHint(
  rootPath: string,
  signal?: AbortSignal,
): Promise<GetWorkspaceContextResult["git"]> {
  throwIfAborted(signal);
  try {
    const options = {
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    };
    const [{ stdout: branchStdout }, { stdout: statusStdout }] = await Promise.all([
      execFileAsync("git", ["-C", rootPath, "rev-parse", "--abbrev-ref", "HEAD"], options),
      execFileAsync("git", ["-C", rootPath, "status", "--porcelain"], options),
    ]);
    throwIfAborted(signal);
    return {
      isGitRepository: true,
      currentBranch: branchStdout.trim() || undefined,
      isDirty: statusStdout.trim().length > 0,
    };
  } catch {
    if (signal?.aborted) {
      throw abortSignalError(signal, "Workspace context Git inspection was cancelled.");
    }
    return { isGitRepository: false };
  }
}

function joinLogical(rootPath: string, relativePath: string): string {
  return rootPath === "." ? relativePath : `${rootPath}/${relativePath}`;
}

async function pathExists(
  absolutePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  try {
    await access(absolutePath);
    throwIfAborted(signal);
    return true;
  } catch {
    if (signal?.aborted) {
      throw abortSignalError(signal, "Workspace context path lookup was cancelled.");
    }
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalError(signal, "Workspace context discovery was cancelled.");
  }
}

const CONTEXT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".runtime",
  ".runtime-private",
  ".runtime-tools",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "releases",
  "runtime",
  "vendor",
]);

function shouldSkipContextDirectory(name: string): boolean {
  return CONTEXT_IGNORED_DIRECTORIES.has(
    process.platform === "win32" ? name.toLocaleLowerCase("en-US") : name,
  );
}
