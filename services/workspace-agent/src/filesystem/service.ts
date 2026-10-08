import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
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

export class FileService {
  constructor(private readonly openReadHandle: (target: string) => Promise<FileHandle> =
    (target) => open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))) {}

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
    security.authorizeWriteLogical(authorized.canonicalRelativePath);

    // Path-based rename/unlink cannot bind the mutation to the object validated
    // above: a directory ancestor may be replaced between checks and rename.
    // Until a handle-relative, cross-platform deletion primitive is available,
    // no destructive operation or staging write is permitted.
    if (input.dryRun !== true) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Destructive delete_file is unavailable until handle-bound deletion is supported.",
      );
    }

    // Advisory, read-only validation: re-resolve after authorization and check
    // identity around the read. This is not a lock on the directory tree.
    const observed = await realpath(authorized.absolutePath);
    const samePath = process.platform === "win32"
      ? observed.toLowerCase() === authorized.canonicalPath.toLowerCase()
      : observed === authorized.canonicalPath;
    if (!samePath) {
      throw new AppError("INVALID_ARGUMENT", "File path changed after authorization.");
    }
    const initial = await lstat(authorized.absolutePath);
    if (!initial.isFile() || initial.isSymbolicLink()) {
      throw new AppError("NOT_A_FILE", "Deletion requires an existing regular file.");
    }
    if (initial.size > workspace.limits.maxFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "File exceeds the workspace file-size limit.");
    }
    // Read through the opened descriptor, not by reopening the pathname.
    // This does not authorize destructive deletion; it only narrows the
    // read-only race between SHA validation and a concurrent name swap.
    const handle = await this.openReadHandle(authorized.absolutePath);
    try {
      const opened = await handle.stat();
      const sameIdentity = (other: typeof initial): boolean =>
        other.isFile() && !other.isSymbolicLink() &&
        other.dev === opened.dev && other.ino === opened.ino &&
        other.size === opened.size && other.mtimeMs === opened.mtimeMs;
      if (!sameIdentity(initial) || opened.size > workspace.limits.maxFileBytes) {
        throw new AppError("INVALID_ARGUMENT", "Opened file identity changed during deletion dry-run.");
      }
      const openedPath = await realpath(authorized.absolutePath);
      const stillAuthorized = process.platform === "win32"
        ? openedPath.toLowerCase() === authorized.canonicalPath.toLowerCase()
        : openedPath === authorized.canonicalPath;
      if (!stillAuthorized || !sameIdentity(await lstat(authorized.absolutePath))) {
        throw new AppError("INVALID_ARGUMENT", "Deletion dry-run target was redirected.");
      }
      const currentHash = hashBuffer(await handle.readFile());
      const latest = await handle.stat();
      if (!sameIdentity(latest) || !sameIdentity(await lstat(authorized.absolutePath))) {
        throw new AppError("INVALID_ARGUMENT", "File identity changed during deletion dry-run.");
      }
      if (currentHash !== input.expectedSha256.toLowerCase()) {
        throw new AppError("INVALID_ARGUMENT", "File changed after it was read; refresh SHA-256 before deletion.");
      }
      return { path: logicalPath, sha256Before: currentHash, deleted: false, dryRun: true };
    } finally {
      await handle.close();
    }
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
