import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
    const authorized = await security.authorizeExisting(input.path, "file");
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
