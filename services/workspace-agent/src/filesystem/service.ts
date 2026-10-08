import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  abortSignalError,
  AppError,
  type ListFilesInput,
  type ListFilesResult,
  type ListWorkspaceRootsResult,
  type PatchFileInput,
  type PatchFileResult,
  type ReadFileInput,
  type ReadFileResult,
  type ReadBinaryFileInput,
  type ReadBinaryFileResult,
  type SearchFilesInput,
  type SearchFilesResult,
  type WriteFileInput,
  type WriteFileResult,
  type DeleteFileInput,
  type DeleteFileResult,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../internal-types.js";
import { collectAuthorizedFiles, listAuthorizedWorkspaceRoots } from "./discovery.js";
import { searchAuthorizedFiles } from "./search.js";
import { PathSecurity } from "../path-security.js";
import {
  atomicWriteBuffer,
  countOccurrences,
  detectLineEnding,
  encodeTextPreservingFormat,
  hashBuffer,
  normalizeReplacementLineEndings,
  readTextFile,
} from "./text-file.js";

interface DeletionFileOperations {
  rename: typeof rename;
  unlink: typeof unlink;
}

export class FileService {
  constructor(private readonly deletionFileOperations: DeletionFileOperations = { rename, unlink }) {}

  async listFiles(
    workspace: ResolvedWorkspace,
    input: ListFilesInput,
    signal?: AbortSignal,
  ): Promise<ListFilesResult> {
    const security = new PathSecurity(workspace);
    const collected = await collectAuthorizedFiles(workspace, security, input, signal);
    return {
      files: collected.files.map(({ logicalPath }) => logicalPath),
      truncated: collected.truncated,
    };
  }

  async listWorkspaceRoots(
    workspace: ResolvedWorkspace,
    signal?: AbortSignal,
  ): Promise<ListWorkspaceRootsResult> {
    const security = new PathSecurity(workspace);
    return listAuthorizedWorkspaceRoots(workspace, security, signal);
  }

  async readFile(
    workspace: ResolvedWorkspace,
    input: ReadFileInput,
  ): Promise<ReadFileResult> {
    const security = new PathSecurity(workspace);
    const authorized = await security.authorizeExisting(input.path, "file", false, "read_file");
    const contents = await readTextFile(
      authorized.canonicalPath,
      workspace.limits.maxFileBytes,
    );
    const lines = contents.text.split(/\r?\n/);
    const startLine = input.startLine ?? 1;
    const requestedEndLine = input.endLine ?? lines.length;
    const endLine = Math.min(requestedEndLine, lines.length);
    const selected = startLine > lines.length ? "" : lines.slice(startLine - 1, endLine).join("\n");

    return {
      path: authorized.logicalPath,
      content: selected,
      startLine,
      endLine: startLine > lines.length ? startLine - 1 : endLine,
      totalLines: lines.length,
      sizeBytes: contents.sizeBytes,
      sha256: contents.sha256,
      encoding: contents.encoding,
      lineEnding: contents.lineEnding,
    };
  }

  async readBinaryFile(
    workspace: ResolvedWorkspace,
    input: ReadBinaryFileInput,
  ): Promise<ReadBinaryFileResult> {
    const security = new PathSecurity(workspace);
    const authorized = await security.authorizeExisting(input.path, "file");
    const contents = await readFile(authorized.canonicalPath);
    if (contents.byteLength > workspace.limits.maxFileBytes) {
      throw new AppError(
        "LIMIT_EXCEEDED",
        "File exceeds the configured workspace file-size limit.",
      );
    }
    return {
      path: authorized.logicalPath,
      contentBase64: contents.toString("base64"),
      sizeBytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  }

  async searchFiles(
    workspace: ResolvedWorkspace,
    input: SearchFilesInput & { caseSensitive: boolean },
    signal?: AbortSignal,
  ): Promise<SearchFilesResult> {
    if (signal?.aborted) {
      throw abortSignalError(signal, "Search operation was cancelled.");
    }
    const security = new PathSecurity(workspace);
    const collected = await collectAuthorizedFiles(
      workspace,
      security,
      {
        ...(input.root === undefined ? {} : { root: input.root }),
        ...(input.glob === undefined ? {} : { glob: input.glob }),
      },
      signal,
    );

    return searchAuthorizedFiles({
      files: collected.files,
      query: input.query,
      caseSensitive: input.caseSensitive,
      maxFileBytes: workspace.limits.maxFileBytes,
      maxSearchResults: workspace.limits.maxSearchResults,
      maxSearchSnippetBytes: workspace.limits.maxSearchSnippetBytes,
      initialTruncated: collected.truncated,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async writeFile(
    workspace: ResolvedWorkspace,
    input: WriteFileInput,
  ): Promise<WriteFileResult> {
    const security = new PathSecurity(workspace);
    const authorized = await security.authorizeWriteTarget(input.path);
    const contentBytes = Buffer.byteLength(input.content, "utf8");
    if (contentBytes > workspace.limits.maxFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "File exceeds the configured size limit.");
    }

    const parentDirectory = path.dirname(authorized.absolutePath);
    await mkdir(parentDirectory, { recursive: true });

    const tempPath = path.join(
      parentDirectory,
      `.vs-code-gpt-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await writeFile(tempPath, input.content, "utf8");
      await rename(tempPath, authorized.absolutePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }

    return {
      path: authorized.logicalPath,
      sizeBytes: contentBytes,
      created: authorized.created,
    };
  }

  async deleteFile(workspace: ResolvedWorkspace, input: DeleteFileInput): Promise<DeleteFileResult> {
    const security = new PathSecurity(workspace);
    const logicalPath = security.authorizeWriteLogical(input.path);
    const authorized = await security.authorizeExisting(input.path, "file");
    // Symlinked ancestors must not redirect a permitted logical path to a non-writable file.
    security.authorizeWriteLogical(authorized.canonicalRelativePath);
    // Existing regular files only. Never follow symlinks, including those within the workspace.
    const initial = await lstat(authorized.absolutePath);
    if (!initial.isFile() || initial.isSymbolicLink()) {
      throw new AppError("NOT_A_FILE", "Deletion requires an existing regular file.");
    }
    if (initial.size > workspace.limits.maxFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "File exceeds the workspace file-size limit.");
    }
    const bytes = await readFile(authorized.absolutePath);
    const currentHash = hashBuffer(bytes);
    if (currentHash !== input.expectedSha256.toLowerCase()) {
      throw new AppError("INVALID_ARGUMENT", "File changed after it was read; refresh SHA-256 before deletion.");
    }
    const latest = await lstat(authorized.absolutePath);
    if (!latest.isFile() || latest.isSymbolicLink() ||
        latest.dev !== initial.dev || latest.ino !== initial.ino ||
        latest.size !== initial.size || latest.mtimeMs !== initial.mtimeMs) {
      throw new AppError("INVALID_ARGUMENT", "File identity changed during deletion preflight.");
    }
    const dryRun = input.dryRun ?? false;
    if (dryRun) return { path: logicalPath, sha256Before: currentHash, deleted: false, dryRun };

    // A rename atomically detaches one directory entry. Revalidate that exact
    // entry in an owner-private staging directory before it can be unlinked.
    // The private directory assumes no hostile process shares the agent's OS identity.
    const stagingDirectory = await mkdtemp(path.join(
      path.dirname(authorized.canonicalPath),
      `.mcp-delete-${randomBytes(16).toString("hex")}-`,
    ));
    const stagedPath = path.join(stagingDirectory, "target");
    let staged = false;
    try {
      await this.deletionFileOperations.rename(authorized.canonicalPath, stagedPath);
      staged = true;
      const moved = await lstat(stagedPath);
      if (!moved.isFile() || moved.isSymbolicLink() ||
          moved.dev !== latest.dev || moved.ino !== latest.ino ||
          moved.size !== latest.size || moved.mtimeMs !== latest.mtimeMs ||
          hashBuffer(await readFile(stagedPath)) !== currentHash) {
        throw new AppError("INVALID_ARGUMENT", "File changed during deletion; no unverified file was deleted.");
      }
      await this.deletionFileOperations.unlink(stagedPath);
      staged = false;
    } catch (error) {
      if (staged) {
        // link() is no-clobber: a concurrent new entry at the source must
        // remain untouched. If restoration is impossible, keep the staged
        // object for explicit reconciliation rather than deleting it.
        try {
          await link(stagedPath, authorized.canonicalPath);
          await this.deletionFileOperations.unlink(stagedPath);
          staged = false;
        } catch {
          throw new AppError(
            "EXECUTION_OUTCOME_UNKNOWN",
            "Deletion was interrupted with a staged file; reconcile the file before any retry.",
            { cause: error, details: {
              path: path.relative(workspace.canonicalRootPath, stagedPath).split(path.sep).join("/"),
              operation: "delete_file", outcome: "unknown", retryable: false,
            } },
          );
        }
      }
      throw error;
    } finally {
      if (!staged) {
        try {
          await rmdir(stagingDirectory);
        } catch (error) {
          throw new AppError(
            "EXECUTION_OUTCOME_UNKNOWN",
            "Deletion staging cleanup was incomplete; reconcile the target before any retry.",
            { cause: error, details: {
              path: path.relative(workspace.canonicalRootPath, stagingDirectory).split(path.sep).join("/"),
              operation: "delete_file", outcome: "unknown", retryable: false,
            } },
          );
        }
      }
    }
    return { path: logicalPath, sha256Before: currentHash, deleted: true, dryRun };
  }

  async patchFile(
    workspace: ResolvedWorkspace,
    input: PatchFileInput,
  ): Promise<PatchFileResult> {
    const security = new PathSecurity(workspace);
    const authorized = await security.authorizeWriteTarget(input.path);
    if (authorized.created) {
      throw new AppError("FILE_NOT_FOUND", "Patch target must already exist.");
    }

    const contents = await readTextFile(authorized.absolutePath, workspace.limits.maxFileBytes);
    if (contents.sha256 !== input.expectedSha256.toLocaleLowerCase("en-US")) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "File changed after it was read; refresh the file and use its current SHA-256.",
      );
    }

    let patched = contents.text;
    let replacementsApplied = 0;
    for (const replacement of input.replacements) {
      const oldText = normalizeReplacementLineEndings(replacement.oldText, contents.lineEnding);
      const newText = normalizeReplacementLineEndings(replacement.newText, contents.lineEnding);
      const actualCount = countOccurrences(patched, oldText);
      const expectedCount = replacement.expectedCount ?? 1;
      if (actualCount !== expectedCount) {
        throw new AppError(
          "INVALID_ARGUMENT",
          `Replacement count mismatch: expected ${expectedCount}, found ${actualCount}.`,
        );
      }
      patched = patched.split(oldText).join(newText);
      replacementsApplied += actualCount;
    }

    const output = encodeTextPreservingFormat(patched, contents.encoding, contents.bom);
    if (output.byteLength > workspace.limits.maxFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "Patched file exceeds the configured size limit.");
    }
    const sha256After = hashBuffer(output);
    const changed = sha256After !== contents.sha256;

    const dryRun = input.dryRun ?? false;
    if (!dryRun && changed) {
      await atomicWriteBuffer(authorized.absolutePath, output);
    }

    return {
      path: authorized.logicalPath,
      sha256Before: contents.sha256,
      sha256After,
      encoding: contents.encoding,
      lineEnding: detectLineEnding(patched),
      replacementsApplied,
      sizeBytes: output.byteLength,
      changed,
      dryRun,
    };
  }
}
