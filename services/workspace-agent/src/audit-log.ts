import { appendFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AppError,
  type AuditEntry,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "./internal-types.js";
import { isContained } from "./path-security.js";

export class AuditLogger {
  private constructor(readonly filePath: string) {}

  static async create(workspaces: ResolvedWorkspace[]): Promise<AuditLogger> {
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
      return new AuditLogger(path.join(canonicalDataDirectory, "audit.ndjson"));
    } catch (error) {
      throw new AppError("AUDIT_FAILED", "Audit log is unavailable.", {
        cause: error,
      });
    }
  }

  async write(entry: AuditEntry): Promise<void> {
    try {
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        flag: "a",
      });
    } catch (error) {
      throw new AppError("AUDIT_FAILED", "Audit log write failed.", {
        cause: error,
      });
    }
  }
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
