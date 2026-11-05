import { randomUUID } from "node:crypto";
import { open, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";

const CHUNK_BYTES = 512 * 1024;
const RETENTION_MS = 60 * 60_000;
const MAX_ARTIFACTS = 512;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Entry = {
  path: string;
  ownerScope: string;
  sizeBytes: number;
  createdAtMs: number;
  filename: string;
  mimeType: "video/webm" | "video/mp4" | "image/gif";
};

export type BrowserArtifactChunk = {
  artifactId: string;
  filename: string;
  mimeType: Entry["mimeType"];
  sizeBytes: number;
  offset: number;
  nextOffset: number;
  contentBase64: string;
};

export class BrowserArtifactRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly directory: string,
    private readonly removeOnExpiry = false,
  ) {}

  async sweep(): Promise<void> {
    await this.prune();
  }

  async register(input: {
    path: string;
    ownerScope?: string;
    mimeType: Entry["mimeType"];
  }): Promise<string | undefined> {
    // Only authenticated identities receive a transferable artifact.
    if (!input.ownerScope) return undefined;
    const root = await realpath(this.directory);
    const file = await realpath(input.path);
    if (path.dirname(file) !== root) {
      throw new AppError("BLOCKED_PATH", "Browser artifact must belong to private media storage.");
    }
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size <= 0) {
      throw new AppError("FILE_NOT_FOUND", "Browser artifact was not finalized.");
    }
    await this.prune();
    if (this.entries.size >= MAX_ARTIFACTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest) await this.evict(oldest);
    }
    const artifactId = randomUUID();
    this.entries.set(artifactId, {
      path: file,
      ownerScope: input.ownerScope,
      sizeBytes: metadata.size,
      createdAtMs: Date.now(),
      filename: path.basename(file),
      mimeType: input.mimeType,
    });
    return artifactId;
  }

  async read(input: {
    artifactId: string;
    ownerScope?: string;
    offset: number;
  }): Promise<BrowserArtifactChunk> {
    await this.prune();
    if (!ID.test(input.artifactId) || !Number.isSafeInteger(input.offset) ||
        input.offset < 0 || !input.ownerScope) {
      throw new AppError("INVALID_ARGUMENT", "Invalid browser artifact read request.");
    }
    const entry = this.entries.get(input.artifactId);
    if (!entry || entry.ownerScope !== input.ownerScope) {
      throw new AppError("FILE_NOT_FOUND", "Browser artifact is unavailable.");
    }
    if (input.offset >= entry.sizeBytes) {
      throw new AppError("INVALID_ARGUMENT", "Artifact offset is out of range.");
    }
    const file = await open(entry.path, "r");
    try {
      const metadata = await file.stat();
      const resolved = await realpath(entry.path);
      if (!metadata.isFile() || metadata.size !== entry.sizeBytes ||
          path.dirname(resolved) !== await realpath(this.directory)) {
        throw new AppError("FILE_NOT_FOUND", "Browser artifact has changed or expired.");
      }
      const length = Math.min(CHUNK_BYTES, entry.sizeBytes - input.offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, input.offset);
      if (bytesRead !== length) throw new AppError("FILE_NOT_FOUND", "Artifact read incomplete.");
      return {
        artifactId: input.artifactId,
        filename: entry.filename,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
        offset: input.offset,
        nextOffset: input.offset + length,
        contentBase64: buffer.toString("base64"),
      };
    } finally {
      await file.close();
    }
  }

  private async evict(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (this.removeOnExpiry) await unlink(entry.path).catch(() => undefined);
  }

  private async prune(): Promise<void> {
    const threshold = Date.now() - RETENTION_MS;
    for (const [id, entry] of this.entries) {
      if (entry.createdAtMs < threshold) await this.evict(id);
    }
  }
}
