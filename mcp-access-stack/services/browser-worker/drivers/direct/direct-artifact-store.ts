import {
  mkdir,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import type {
  BrowserArtifact,
  BrowserArtifactCollection,
  BrowserArtifactKind,
} from "../browser-advanced-driver.js";
import { resolveBrowserPrivateOutputPath } from "../browser-driver.js";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";

interface ArtifactSnapshotEntry {
  sizeBytes: number;
  modifiedAtMs: number;
}

export type DirectArtifactSnapshot = ReadonlyMap<
  string,
  ArtifactSnapshotEntry
>;

export interface DirectArtifactMetrics {
  artifactStorageBytes: number;
  artifactCount: number;
}

export class DirectArtifactStore {
  constructor(
    private readonly rootDirectory: string,
    private readonly config: BrowserWorkerConfig,
  ) {}

  async prepare(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    await this.prune();
  }

  resolveFilename(
    filename: string | undefined,
    defaultPrefix: string,
    extension: string,
  ): string {
    const value = filename ?? `${defaultPrefix}-${Date.now()}${extension}`;
    if (
      value.length > 180 ||
      value.includes("/") ||
      value.includes("\\") ||
      value.includes("..") ||
      /[\r\n\0]/.test(value)
    ) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "Browser artifact filename must be a simple filename with at most 180 characters.",
      );
    }
    const normalizedExtension = extension.toLocaleLowerCase("en-US");
    const normalizedValue = value.toLocaleLowerCase("en-US");
    const finalName = normalizedValue.endsWith(normalizedExtension)
      ? value
      : `${value}${extension}`;
    return resolveBrowserPrivateOutputPath(this.rootDirectory, finalName);
  }

  async metrics(): Promise<DirectArtifactMetrics> {
    const files = await listFilesRecursively(this.rootDirectory);
    let artifactStorageBytes = 0;
    let artifactCount = 0;
    for (const file of files) {
      const metadata = await stat(file).catch(() => undefined);
      if (!metadata?.isFile()) continue;
      artifactStorageBytes += metadata.size;
      artifactCount += 1;
    }
    return { artifactStorageBytes, artifactCount };
  }

  async snapshot(): Promise<DirectArtifactSnapshot> {
    const files = await listFilesRecursively(this.rootDirectory);
    const result = new Map<string, ArtifactSnapshotEntry>();
    for (const file of files) {
      const metadata = await stat(file);
      if (!metadata.isFile()) continue;
      result.set(file, {
        sizeBytes: metadata.size,
        modifiedAtMs: metadata.mtimeMs,
      });
    }
    return result;
  }

  async collectChanged(
    kind: BrowserArtifactKind,
    baseline: DirectArtifactSnapshot,
  ): Promise<BrowserArtifactCollection> {
    const current = await this.snapshot();
    const changed: BrowserArtifact[] = [];
    for (const [file, metadata] of current) {
      const previous = baseline.get(file);
      if (
        previous &&
        previous.sizeBytes === metadata.sizeBytes &&
        previous.modifiedAtMs === metadata.modifiedAtMs
      ) {
        continue;
      }
      changed.push(await this.describe(kind, file));
    }
    if (changed.length === 0) {
      throw new AppError(
        "RELAY_PROTOCOL_ERROR",
        `The direct browser engine produced no ${kind} artifacts.`,
      );
    }
    const totalBytes = changed.reduce((total, file) => total + file.sizeBytes, 0);
    if (totalBytes > this.config.outputMaxBytes) {
      await Promise.all(
        changed.map((file) => unlink(file.path).catch(() => undefined)),
      );
      throw new AppError(
        "LIMIT_EXCEEDED",
        `Direct browser ${kind} artifacts exceeded the configured byte limit.`,
      );
    }
    return {
      kind,
      files: changed.sort((left, right) => left.path.localeCompare(right.path)),
      totalBytes,
      createdAt: new Date().toISOString(),
    };
  }

  async describe(
    kind: BrowserArtifactKind,
    value: string,
  ): Promise<BrowserArtifact> {
    const file = resolveBrowserPrivateOutputPath(this.rootDirectory, value);
    const metadata = await stat(file).catch((error: unknown) => {
      throw new AppError(
        "FILE_NOT_FOUND",
        `Direct browser ${kind} artifact was not created.`,
        { cause: error },
      );
    });
    if (!metadata.isFile()) {
      throw new AppError(
        "NOT_A_FILE",
        `Direct browser ${kind} artifact is not a file.`,
      );
    }
    if (metadata.size > this.config.outputMaxBytes) {
      await unlink(file).catch(() => undefined);
      throw new AppError(
        "LIMIT_EXCEEDED",
        `Direct browser ${kind} artifact exceeded the configured byte limit.`,
      );
    }
    return {
      kind,
      path: file,
      sizeBytes: metadata.size,
      createdAt: metadata.birthtime.toISOString(),
    };
  }

  private async prune(): Promise<void> {
    const retentionMs = this.config.diagnosticRetentionMs;
    const maxArtifacts = this.config.diagnosticMaxArtifacts;
    const now = Date.now();
    const files = await listFilesRecursively(this.rootDirectory);
    const entries = await Promise.all(
      files.map(async (file) => ({ file, metadata: await stat(file) })),
    );
    const retained = entries
      .filter((entry) => entry.metadata.isFile())
      .sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);

    for (const entry of retained) {
      if (now - entry.metadata.mtimeMs > retentionMs) {
        await unlink(entry.file).catch(() => undefined);
      }
    }

    const afterRetention = retained.filter(
      (entry) => now - entry.metadata.mtimeMs <= retentionMs,
    );
    for (const entry of afterRetention.slice(maxArtifacts)) {
      await unlink(entry.file).catch(() => undefined);
    }
  }
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const value = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(value);
      else if (entry.isFile()) result.push(value);
    }
  }
  return result;
}
