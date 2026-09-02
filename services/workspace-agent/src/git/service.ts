import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  abortSignalError,
  AppError,
  createOperationDeadline,
  createOperationLifecycle,
  QUICK_OPERATION_TIMEOUT_MS,
  type InspectGitInput,
  type InspectGitResult,
} from "@vs-code-gpt/shared";
import type { AuthorizedPath, ResolvedWorkspace } from "../internal-types.js";
import { runGitInBatches, runGitStrict } from "./process-runner.js";
import {
  parsePorcelainStatus,
  relativizeGitEntry,
  type ParsedGitStatus,
} from "./status.js";
import {
  isContained,
  PathSecurity,
} from "../path-security.js";
import { authorizeGitOperationalRoot } from "./operational-root.js";

interface GitContext {
  repositoryRoot: string;
  rootPrefix: string;
}

export class GitService {
  private readonly contextCache = new Map<string, Promise<GitContext>>();

  async inspect(
    workspace: ResolvedWorkspace,
    input: InspectGitInput,
    externalSignal?: AbortSignal,
  ): Promise<InspectGitResult> {
    const root = input.root ?? ".";
    const paths = input.paths ?? [];
    const diffMode = input.diffMode ?? "summary";
    const requestedMaxDiffBytes = input.maxDiffBytes ?? 40_000;
    const timeoutMs = input.timeoutMs ?? QUICK_OPERATION_TIMEOUT_MS;
    const deadline = createDeadlineSignal(timeoutMs, externalSignal);
    try {
      throwIfAborted(deadline.signal);
      const security = new PathSecurity(workspace);
      const authorizedRoot = await authorizeGitOperationalRoot(
        workspace,
        security,
        root,
      );
      const context = await this.resolveGitContext(authorizedRoot.canonicalPath, deadline.signal);
      const filters = await Promise.all(
        paths.map((candidate) =>
          authorizeFilterPath(security, authorizedRoot.logicalPath, candidate),
        ),
      );
      const repositoryPathspecs =
        filters.length === 0
          ? [context.rootPrefix]
          : filters.map((candidate) => toRepositoryPath(context.rootPrefix, candidate));
      const statusOutput = await runGitStrict(
        context.repositoryRoot,
        [
          "-c",
          "status.relativePaths=false",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--",
          ...repositoryPathspecs,
        ],
        workspace.limits.maxDiffBytes,
        deadline.signal,
      );
      const parsedStatus = parsePorcelainStatus(statusOutput);
      const allowedStatus: Array<{
        status: ParsedGitStatus;
        repositoryPath: string;
      }> = [];

      for (const repositoryEntry of parsedStatus) {
        const relativeEntry = relativizeGitEntry(repositoryEntry, context.rootPrefix);
        if (!relativeEntry) continue;
        if (!(await isAllowedGitEntry(security, authorizedRoot.logicalPath, relativeEntry.status))) {
          continue;
        }
        allowedStatus.push(relativeEntry);
      }

      const branch = (
        await runGitStrict(
          context.repositoryRoot,
          ["rev-parse", "--abbrev-ref", "HEAD"],
          8_192,
          deadline.signal,
        )
      ).trim();
      const maxDiffBytes = Math.min(requestedMaxDiffBytes, workspace.limits.maxDiffBytes);
      let staged = "";
      let unstaged = "";
      let truncated = false;

      if (diffMode !== "none") {
        const trackedPaths = allowedStatus
          .filter(({ status }) => !status.untracked)
          .map(({ repositoryPath }) => repositoryPath);
        const relativeArg = relativeDiffArg(context.rootPrefix);
        const diffFlags =
          diffMode === "summary"
            ? ["--stat", "--summary"]
            : ["--binary"];
        const stagedResult = await runGitInBatches(
          context.repositoryRoot,
          [
            "diff",
            relativeArg,
            "--cached",
            "--no-ext-diff",
            ...diffFlags,
            "--",
          ],
          trackedPaths,
          maxDiffBytes,
          deadline.signal,
        );
        const unstagedResult = await runGitInBatches(
          context.repositoryRoot,
          ["diff", relativeArg, "--no-ext-diff", ...diffFlags, "--"],
          trackedPaths,
          stagedResult.remainingBytes,
          deadline.signal,
        );
        staged = stagedResult.output;
        unstaged = unstagedResult.output;
        truncated = stagedResult.truncated || unstagedResult.truncated;
      }

      return {
        workspaceId: input.workspaceId,
        root: authorizedRoot.logicalPath,
        branch: branch || "HEAD",
        diffMode,
        status: allowedStatus.map(({ status }) => {
          const { untracked: _untracked, ...entry } = status;
          return entry;
        }),
        staged,
        unstaged,
        truncated,
      };
    } finally {
      deadline.dispose();
    }
  }

  private resolveGitContext(
    canonicalRoot: string,
    signal?: AbortSignal,
  ): Promise<GitContext> {
    const cacheKey = normalizeForComparison(canonicalRoot);
    const cached = this.contextCache.get(cacheKey);
    if (cached) return cached;

    const pending = this.loadGitContext(canonicalRoot, signal);
    this.contextCache.set(cacheKey, pending);
    void pending.catch(() => {
      if (this.contextCache.get(cacheKey) === pending) {
        this.contextCache.delete(cacheKey);
      }
    });
    return pending;
  }

  private async loadGitContext(
    canonicalRoot: string,
    signal?: AbortSignal,
  ): Promise<GitContext> {
    try {
      const inside = (
        await runGitStrict(
          canonicalRoot,
          ["rev-parse", "--is-inside-work-tree"],
          1_024,
          signal,
        )
      ).trim();
      if (inside !== "true") throw new Error("Not inside a worktree");
      const topLevel = (
        await runGitStrict(
          canonicalRoot,
          ["rev-parse", "--show-toplevel"],
          8_192,
          signal,
        )
      ).trim();
      const canonicalTopLevel = await realpath(topLevel);
      if (!isContained(canonicalTopLevel, canonicalRoot)) {
        throw new Error("Selected root is outside the resolved Git worktree");
      }
      const relativePrefix = path.relative(canonicalTopLevel, canonicalRoot);
      return {
        repositoryRoot: canonicalTopLevel,
        rootPrefix:
          relativePrefix.length === 0
            ? "."
            : relativePrefix.split(path.sep).join("/"),
      };
    } catch (error) {
      if (
        error instanceof AppError &&
        ["AGENT_TIMEOUT", "OPERATION_CANCELLED", "AGENT_UNAVAILABLE"].includes(
          error.code,
        )
      ) {
        throw error;
      }
      throw new AppError(
        "NOT_GIT_REPOSITORY",
        "The selected workspace root is not inside a Git worktree.",
        { cause: error },
      );
    }
  }
}

async function authorizeFilterPath(
  security: PathSecurity,
  root: string,
  candidate: string,
): Promise<string> {
  const normalized = normalizeLogicalPath(candidate);
  const workspacePath = root === "." ? normalized : `${root}/${normalized}`;
  security.authorizeLogical(workspacePath, true);
  try {
    await security.authorizeExisting(workspacePath, undefined, true);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "FILE_NOT_FOUND") throw error;
  }
  return normalized;
}

function toRepositoryPath(rootPrefix: string, candidate: string): string {
  return rootPrefix === "." ? candidate : `${rootPrefix}/${candidate}`;
}

function relativeDiffArg(rootPrefix: string): string {
  return rootPrefix === "." ? "--relative" : `--relative=${rootPrefix}`;
}

async function isAllowedGitEntry(
  security: PathSecurity,
  root: string,
  entry: ParsedGitStatus,
): Promise<boolean> {
  const candidates = entry.originalPath ? [entry.path, entry.originalPath] : [entry.path];
  for (const candidate of candidates) {
    const workspacePath = root === "." ? candidate : `${root}/${candidate}`;
    try {
      security.authorizeLogical(workspacePath);
      try {
        await security.authorizeExisting(workspacePath);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "FILE_NOT_FOUND") throw error;
      }
    } catch (error) {
      if (
        error instanceof AppError &&
        [
          "BLOCKED_PATH",
          "PATH_OUTSIDE_ALLOWED_ROOTS",
          "PATH_OUTSIDE_WORKSPACE",
          "INVALID_PATH",
        ].includes(error.code)
      ) {
        return false;
      }
      throw error;
    }
  }
  return true;
}

function normalizeLogicalPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizeForComparison(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalError(signal, "Git operation was cancelled.");
  }
}

function createDeadlineSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const startedAt = Date.now();
  const deadline = createOperationDeadline(timeoutMs, undefined, startedAt);
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) onExternalAbort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new AppError("AGENT_TIMEOUT", "Git deadline has expired.", {
          lifecycle: createOperationLifecycle(deadline, startedAt, {
            layer: "executor",
            reason: "timeout",
            diagnostic: "Git inspection exceeded its effective operation timeout.",
          }),
        }),
      ),
    timeoutMs,
  );
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}
