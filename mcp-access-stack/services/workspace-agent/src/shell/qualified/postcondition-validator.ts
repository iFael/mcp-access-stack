import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  abortSignalError,
  type CommandPlan,
  type CommandPostcondition,
  type CommandPostconditionResult,
  type RunCommandResult,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../../internal-types.js";
import { PathSecurity } from "../../path-security.js";
import { NativeCommandContextProbe } from "./context-probe.js";

export async function validateCommandPostconditions(
  workspace: ResolvedWorkspace,
  plan: CommandPlan,
  result: Extract<RunCommandResult, { status: "executed" }>,
  elapsedMs: number,
  signal?: AbortSignal,
): Promise<CommandPostconditionResult> {
  let failed = 0;
  for (const postcondition of plan.postconditions) {
    if (signal?.aborted) {
      throw abortSignalError(signal, "Postcondition validation was cancelled.");
    }
    if (
      !(await evaluatePostcondition(
        workspace,
        plan,
        result,
        postcondition,
        elapsedMs,
      ))
    ) {
      failed += 1;
    }
  }
  return {
    passed: failed === 0,
    checked: plan.postconditions.length,
    failed,
  };
}

async function evaluatePostcondition(
  workspace: ResolvedWorkspace,
  plan: CommandPlan,
  result: Extract<RunCommandResult, { status: "executed" }>,
  postcondition: CommandPostcondition,
  elapsedMs: number,
): Promise<boolean> {
  try {
    switch (postcondition.kind) {
      case "exit_code":
        return result.exitCode === postcondition.value;
      case "text_contains":
        return result[postcondition.stream].includes(postcondition.value);
      case "duration_lte":
        return elapsedMs <= postcondition.valueMs;
      case "file_exists": {
        const security = new PathSecurity(workspace);
        await security.authorizeExisting(
          resolveFromCwd(plan.cwd, postcondition.path),
        );
        return true;
      }
      case "file_absent":
        return isSafelyAbsent(
          workspace,
          resolveFromCwd(plan.cwd, postcondition.path),
        );
      case "sha256": {
        const file = await authorizeBoundedFile(
          workspace,
          resolveFromCwd(plan.cwd, postcondition.path),
        );
        const digest = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
        return digest === postcondition.value;
      }
      case "json_field": {
        const file = await authorizeBoundedFile(
          workspace,
          resolveFromCwd(plan.cwd, postcondition.path),
        );
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        return Object.is(resolveJsonPointer(parsed, postcondition.pointer), postcondition.value);
      }
      case "git_clean": {
        const security = new PathSecurity(workspace);
        const root = await security.authorizeExisting(
          resolveFromCwd(plan.cwd, postcondition.root),
          "directory",
          true,
        );
        const git = await new NativeCommandContextProbe().getGitContext(
          root.canonicalPath,
        );
        return git.repository && git.dirty === false;
      }
      case "http_status":
      case "process_exited":
        return false;
    }
  } catch {
    return false;
  }
}

async function authorizeBoundedFile(
  workspace: ResolvedWorkspace,
  logicalPath: string,
): Promise<string> {
  const security = new PathSecurity(workspace);
  const authorized = await security.authorizeExisting(logicalPath, "file");
  const metadata = await stat(authorized.canonicalPath);
  if (metadata.size > workspace.limits.maxFileBytes) {
    throw new Error("Postcondition file exceeds the workspace read limit.");
  }
  return authorized.canonicalPath;
}

async function isSafelyAbsent(
  workspace: ResolvedWorkspace,
  logicalPath: string,
): Promise<boolean> {
  const security = new PathSecurity(workspace);
  const authorizedLogical = security.authorizeLogical(logicalPath);
  try {
    await security.authorizeExisting(authorizedLogical);
    return false;
  } catch (error) {
    if (!isMissingPathError(error)) return false;
  }

  let parent = path.posix.dirname(authorizedLogical);
  while (true) {
    const candidate = parent === "" ? "." : parent;
    try {
      await security.authorizeExisting(candidate, "directory", true);
      return true;
    } catch (error) {
      if (!isMissingPathError(error)) return false;
    }
    if (candidate === ".") return false;
    parent = path.posix.dirname(candidate);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FILE_NOT_FOUND"
  );
}

function resolveFromCwd(logicalCwd: string, target: string): string {
  if (logicalCwd === ".") return target;
  if (target === ".") return logicalCwd;
  return `${logicalCwd}/${target}`;
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
