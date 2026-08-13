import {
  AppError,
  asAppError,
  type OperationContext,
} from "@vs-code-gpt/shared";
import { z } from "zod";
import type { RelayWorkspaceExecutor } from "../relay/workspace-executor.js";
import {
  prepareWorkspaceTaskInputSchema,
  readFilesActionInputSchema,
  validateWorkspaceChangesInputSchema,
} from "./schemas.js";

export type WorkspaceWorkflowExecutor = Pick<
  RelayWorkspaceExecutor,
  | "inspectGit"
  | "getWorkspaceContext"
  | "listFiles"
  | "readFile"
  | "runValidation"
>;

export async function prepareWorkspaceTask(
  executor: WorkspaceWorkflowExecutor,
  input: z.infer<typeof prepareWorkspaceTaskInputSchema>,
  context: OperationContext = {},
) {
  executor = bindOperationContext(executor, context);
  const git = await executor.inspectGit({
    workspaceId: input.workspaceId,
    root: input.root,
    diffMode: "summary",
    paths: input.targetPaths,
    maxDiffBytes: 30_000,
    timeoutMs: input.timeoutMs,
  });
  const [workspaceContext, targetContext] = await Promise.all([
    executor.getWorkspaceContext({ workspaceId: input.workspaceId, root: "." }),
    executor.getWorkspaceContext({ workspaceId: input.workspaceId, root: input.root }),
  ]);
  const [rootCodexFiles, nestedCodexFiles, configFiles] = await Promise.all([
    executor.listFiles({
      workspaceId: input.workspaceId,
      root: ".",
      glob: ".codex/*.md",
    }),
    executor.listFiles({
      workspaceId: input.workspaceId,
      root: input.root,
      glob: "**/.codex/*.md",
    }),
    executor.listFiles({
      workspaceId: input.workspaceId,
      root: input.root,
      glob: "**/config.jsonc",
    }),
  ]);

  const candidateDocuments = new Set<string>();
  for (const instruction of [
    ...workspaceContext.instructionFiles,
    ...targetContext.instructionFiles,
  ]) {
    candidateDocuments.add(instruction.path);
  }
  for (const path of [
    ...workspaceContext.availableInstructionFiles,
    ...targetContext.availableInstructionFiles,
  ]) {
    if (isDocumentApplicable(path, input.root, input.targetPaths, false)) {
      candidateDocuments.add(path);
    }
  }
  for (const path of rootCodexFiles.files) {
    candidateDocuments.add(path);
  }
  for (const path of nestedCodexFiles.files) {
    if (isDocumentApplicable(path, input.root, input.targetPaths, true)) {
      candidateDocuments.add(path);
    }
  }
  for (const path of selectNearestConfigFiles(configFiles.files, input.root, input.targetPaths)) {
    candidateDocuments.add(path);
  }
  candidateDocuments.add(joinLogicalPath(input.root, "README.md"));
  candidateDocuments.add(joinLogicalPath(input.root, ".editorconfig"));

  const recommendedReads = [...candidateDocuments].sort();
  const documentRead = input.includeDocumentContents
    ? await readOptionalDocuments(
        executor,
        input.workspaceId,
        recommendedReads,
        input.maxDocumentBytes,
      )
    : { documents: [], omittedDocuments: recommendedReads };
  const warnings: string[] = [];
  if (input.intent === "change" && git.branch.toLocaleLowerCase("en-US") === "main") {
    warnings.push("The selected repository is on main; do not modify this branch.");
  }
  if (git.status.length > 0) {
    warnings.push("The working tree already contains changes that must be preserved.");
  }
  if (rootCodexFiles.truncated || nestedCodexFiles.truncated || configFiles.truncated) {
    warnings.push("Document discovery reached a workspace listing limit.");
  }

  return {
    workspaceId: input.workspaceId,
    root: input.root,
    intent: input.intent,
    targetPaths: input.targetPaths,
    context: targetContext,
    git,
    recommendedReads,
    documents: documentRead.documents,
    omittedDocuments: documentRead.omittedDocuments,
    warnings,
  };
}

export async function validateWorkspaceChanges(
  executor: WorkspaceWorkflowExecutor,
  input: z.infer<typeof validateWorkspaceChangesInputSchema>,
  context: OperationContext = {},
) {
  executor = bindOperationContext(executor, context);
  const git = await executor.inspectGit({
    workspaceId: input.workspaceId,
    root: input.root,
    diffMode: "full",
    paths: input.paths ?? [],
    maxDiffBytes: input.maxDiffBytes,
    timeoutMs: input.timeoutMs,
  });
  const changedPaths = git.status.map((entry) => entry.path);
  const issues: string[] = [];
  const warnings: string[] = [];

  if (git.branch.toLocaleLowerCase("en-US") === "main") {
    issues.push("The selected repository is on main.");
  }
  if (input.expectedBranch && git.branch !== input.expectedBranch) {
    issues.push(`Expected branch ${input.expectedBranch}, but found ${git.branch}.`);
  }
  if (input.allowedPathPrefixes) {
    const outside = changedPaths.filter(
      (path) => !input.allowedPathPrefixes?.some((prefix) => pathMatchesPrefix(path, prefix)),
    );
    if (outside.length > 0) {
      issues.push(`Changes outside allowedPathPrefixes: ${outside.join(", ")}`);
    }
  }
  const forbidden = changedPaths.filter((path) =>
    input.forbiddenPathPrefixes.some((prefix) => pathMatchesPrefix(path, prefix)),
  );
  if (forbidden.length > 0) {
    issues.push(`Changes under forbiddenPathPrefixes: ${forbidden.join(", ")}`);
  }
  if (git.truncated) {
    warnings.push("The returned Git diff was truncated by maxDiffBytes.");
  }

  const diffCheckValidation = await executor.runValidation({
    workspaceId: input.workspaceId,
    root: input.root,
    validation: "diff-check",
    scope: input.paths && input.paths.length > 0 ? "paths" : "changes",
    paths: input.paths ?? [],
    maxFindings: 100,
    timeoutMs: input.timeoutMs,
  });
  const diffCheckPassed = diffCheckValidation.executed && diffCheckValidation.passed;
  if (!diffCheckPassed) {
    issues.push(
      diffCheckValidation.issues[0] ??
        diffCheckValidation.findings[0]?.message ??
        "git diff --check failed.",
    );
  }

  const metadataPaths = changedPaths
    .filter((path) => isTextMetadataCandidate(path))
    .slice(0, 20)
    .map((path) => joinLogicalPath(input.root, path));
  const metadata = await readOptionalFileMetadata(executor, input.workspaceId, metadataPaths);
  if (changedPaths.length > metadataPaths.length) {
    warnings.push("File metadata inspection was limited to twenty changed text files.");
  }

  return {
    workspaceId: input.workspaceId,
    root: input.root,
    branch: git.branch,
    passed: issues.length === 0,
    changedPaths,
    status: git.status,
    staged: git.staged,
    unstaged: git.unstaged,
    truncated: git.truncated,
    diffCheck: {
      passed: diffCheckPassed,
      stdout: diffCheckValidation.findings
        .map((finding) => `${finding.path}:${finding.line ?? 0}: ${finding.message}`)
        .join("\n"),
      stderr: diffCheckValidation.issues.join("\n"),
    },
    fileMetadata: metadata,
    testsExecuted: false,
    issues,
    warnings,
  };
}

async function readOptionalDocuments(
  executor: WorkspaceWorkflowExecutor,
  workspaceId: string,
  paths: string[],
  maxTotalBytes: number,
) {
  const documents = [];
  const omittedDocuments: string[] = [];
  let totalBytes = 0;
  for (const path of paths.slice(0, 20)) {
    try {
      const document = await executor.readFile({ workspaceId, path });
      const bytes = Buffer.byteLength(document.content, "utf8");
      if (totalBytes + bytes > maxTotalBytes || documents.length >= 10) {
        omittedDocuments.push(path);
        continue;
      }
      documents.push(document);
      totalBytes += bytes;
    } catch (error) {
      const appError = asAppError(error);
      if (["FILE_NOT_FOUND", "NOT_A_FILE"].includes(appError.code)) continue;
      throw appError;
    }
  }
  omittedDocuments.push(...paths.slice(20));
  return { documents, omittedDocuments };
}

async function readOptionalFileMetadata(
  executor: WorkspaceWorkflowExecutor,
  workspaceId: string,
  paths: string[],
) {
  const metadata = [];
  for (const path of paths) {
    try {
      const file = await executor.readFile({ workspaceId, path, startLine: 1, endLine: 1 });
      metadata.push({
        path: file.path,
        sha256: file.sha256,
        encoding: file.encoding,
        lineEnding: file.lineEnding,
        sizeBytes: file.sizeBytes,
      });
    } catch (error) {
      const appError = asAppError(error);
      if (["FILE_NOT_FOUND", "NOT_A_FILE", "BINARY_FILE"].includes(appError.code)) continue;
      throw appError;
    }
  }
  return metadata;
}

function isDocumentApplicable(
  workspacePath: string,
  root: string,
  targetPaths: string[],
  codexDocument: boolean,
): boolean {
  const relative = toRootRelativePath(workspacePath, root);
  if (relative === undefined) return false;
  const scope = codexDocument
    ? relative.replace(/(?:^|\/)\.codex\/[^/]+$/i, "") || "."
    : relative.includes("/")
      ? relative.slice(0, relative.lastIndexOf("/"))
      : ".";
  if (targetPaths.length === 0) return scope === ".";
  return targetPaths.some((target) => pathMatchesPrefix(target, scope));
}

function selectNearestConfigFiles(
  files: string[],
  root: string,
  targetPaths: string[],
): string[] {
  if (targetPaths.length === 0) {
    const rootConfig = joinLogicalPath(root, "config.jsonc");
    return files.includes(rootConfig) ? [rootConfig] : [];
  }
  const selected = new Set<string>();
  for (const target of targetPaths) {
    const candidates = files
      .map((path) => ({ path, relative: toRootRelativePath(path, root) }))
      .filter((entry): entry is { path: string; relative: string } => entry.relative !== undefined)
      .filter((entry) => {
        const directory = entry.relative.slice(0, Math.max(0, entry.relative.lastIndexOf("/"))) || ".";
        return pathMatchesPrefix(target, directory);
      })
      .sort((left, right) => right.relative.length - left.relative.length);
    if (candidates[0]) selected.add(candidates[0].path);
  }
  return [...selected];
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPrefix = prefix.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalizedPrefix === "." || normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function joinLogicalPath(root: string, relative: string): string {
  return root === "." ? relative : `${root.replace(/\/$/, "")}/${relative}`;
}

function toRootRelativePath(path: string, root: string): string | undefined {
  if (root === ".") return path;
  const prefix = `${root.replace(/\/$/, "")}/`;
  return path === root ? "." : path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function bindOperationContext(
  executor: WorkspaceWorkflowExecutor,
  context: OperationContext,
): WorkspaceWorkflowExecutor {
  return {
    inspectGit: (input) => executor.inspectGit(input, context),
    getWorkspaceContext: (input) => executor.getWorkspaceContext(input, context),
    listFiles: (input) => executor.listFiles(input, context),
    readFile: (input) => executor.readFile(input, context),
    runValidation: (input) => executor.runValidation(input, context),
  };
}
function isTextMetadataCandidate(path: string): boolean {
  return /\.(?:c|cc|cpp|cs|css|es3|h|html|java|js|json|jsonc|md|mjs|ps1|py|sql|ts|tsx|txt|xml|yaml|yml)$/i.test(path);
}

export async function readWorkspaceFiles(
  executor: WorkspaceWorkflowExecutor,
  input: z.infer<typeof readFilesActionInputSchema>,
  context: OperationContext = {},
) {
  executor = bindOperationContext(executor, context);
  const files = [];
  for (let offset = 0; offset < input.files.length; offset += 3) {
    const batch = input.files.slice(offset, offset + 3);
    files.push(
      ...(await Promise.all(
        batch.map((file) =>
          executor.readFile({
            workspaceId: input.workspaceId,
            path: file.path,
            ...(file.startLine === undefined ? {} : { startLine: file.startLine }),
            ...(file.endLine === undefined ? {} : { endLine: file.endLine }),
          }),
        ),
      )),
    );
  }
  const totalBytes = files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  if (totalBytes > input.maxTotalBytes) {
    throw new AppError(
      "LIMIT_EXCEEDED",
      "Batch read exceeded maxTotalBytes; request fewer files or narrower line ranges.",
    );
  }
  return { workspaceId: input.workspaceId, files, totalBytes };
}
