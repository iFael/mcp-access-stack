import {
  appendFile,
  mkdir,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AppError,
  type AuditEntry,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "./internal-types.js";
import { isContained } from "./path-security.js";

const DEFAULT_MAX_FILE_BYTES = 128 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 64;
const ROTATED_AUDIT_FILE = /^audit\..+\.ndjson$/u;

export interface AuditLoggerOptions {
  maxFileBytes?: number;
  maxRotatedFiles?: number;
}

export interface AuditWriteMetrics {
  appendDurationMs: number;
  totalDurationMs: number;
  rotated: boolean;
  activeFileBytes: number;
}

export class AuditLogger {
  private readonly maxFileBytes: number;
  private readonly maxRotatedFiles: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private rotationSequence = 0;

  private constructor(
    readonly filePath: string,
    options: AuditLoggerOptions = {},
  ) {
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
    );
    this.maxRotatedFiles = nonnegativeInteger(
      options.maxRotatedFiles,
      DEFAULT_MAX_ROTATED_FILES,
    );
  }

  static async create(
    workspaces: ResolvedWorkspace[],
    options: AuditLoggerOptions = {},
  ): Promise<AuditLogger> {
    const dataDirectory = getDataDirectory();
    try {
      await mkdir(dataDirectory, { recursive: true });
      const canonicalDataDirectory = await realpath(dataDirectory);
      if (
        workspaces.some((workspace) =>
          isContained(workspace.canonicalRootPath, canonicalDataDirectory),
        )
      ) {
        throw new Error("Audit directory is inside an authorized workspace.");
      }
      return new AuditLogger(
        path.join(canonicalDataDirectory, "audit.ndjson"),
        options,
      );
    } catch (error) {
      throw new AppError("AUDIT_FAILED", "Audit log is unavailable.", {
        cause: error,
      });
    }
  }

  async write(entry: AuditEntry): Promise<AuditWriteMetrics> {
    const execute = () => this.writeEntry(entry);
    const pending = this.writeQueue.then(execute, execute);
    this.writeQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async writeEntry(entry: AuditEntry): Promise<AuditWriteMetrics> {
    const totalStartedAt = performance.now();
    try {
      const line = `${JSON.stringify(entry)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      const currentBytes = await fileSizeOrZero(this.filePath);
      const shouldRotate =
        currentBytes > 0 && currentBytes + lineBytes > this.maxFileBytes;

      if (shouldRotate) {
        await this.rotateActiveFile();
      }

      const appendStartedAt = performance.now();
      await appendFile(this.filePath, line, {
        encoding: "utf8",
        flag: "a",
      });
      const appendDurationMs = elapsedMs(appendStartedAt);

      return {
        appendDurationMs,
        totalDurationMs: elapsedMs(totalStartedAt),
        rotated: shouldRotate,
        activeFileBytes: (shouldRotate ? 0 : currentBytes) + lineBytes,
      };
    } catch (error) {
      throw new AppError("AUDIT_FAILED", "Audit log write failed.", {
        cause: error,
      });
    }
  }

  private async rotateActiveFile(): Promise<void> {
    const directory = path.dirname(this.filePath);
    this.rotationSequence += 1;
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const sequence = String(this.rotationSequence).padStart(6, "0");
    const rotatedPath = path.join(
      directory,
      `audit.${timestamp}.${process.pid}.${sequence}.ndjson`,
    );

    await rename(this.filePath, rotatedPath);
    await this.pruneRotatedFiles(directory);
  }

  private async pruneRotatedFiles(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && ROTATED_AUDIT_FILE.test(entry.name));

    if (entries.length <= this.maxRotatedFiles) {
      return;
    }

    const candidates = await Promise.all(
      entries.map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const metadata = await stat(filePath);
        return {
          filePath,
          name: entry.name,
          mtimeMs: metadata.mtimeMs,
        };
      }),
    );

    candidates.sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
    );

    for (const candidate of candidates.slice(this.maxRotatedFiles)) {
      await unlink(candidate.filePath);
    }
  }
}

async function fileSizeOrZero(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
}

function getDataDirectory(): string {
  if (process.env.VS_CODE_GPT_DATA_DIR) {
    return path.resolve(process.env.VS_CODE_GPT_DATA_DIR);
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "vs-code-gpt");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "vs-code-gpt");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "vs-code-gpt");
}
