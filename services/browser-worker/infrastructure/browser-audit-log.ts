import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface BrowserAuditEntry {
  timestamp: string;
  operation: string;
  tabId?: string;
  status: "allowed" | "denied" | "error";
  reason?: string;
  durationMs: number;
  queueWaitMs?: number;
  operationUnits?: number;
}

export class BrowserAuditLogger {
  readonly filePath: string;

  constructor(runtimeDirectory: string) {
    this.filePath = path.join(runtimeDirectory, "browser-audit.ndjson");
  }

  async write(entry: BrowserAuditEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
