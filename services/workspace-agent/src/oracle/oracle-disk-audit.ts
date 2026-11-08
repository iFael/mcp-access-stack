import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import {
  oracleDiskAuditResultSchema,
  type OracleDiskAuditInput,
  type OracleDiskAuditResult,
} from "@vs-code-gpt/shared";

const HELPER = "/usr/local/libexec/mcp-v3-disk-audit";
const SUDO = "/usr/bin/sudo";
const MAX_OUTPUT = 32 * 1024;
const TIMEOUT_MS = 65_000;

type Runner = (request: OracleDiskAuditInput, signal?: AbortSignal) => Promise<string>;

export interface OracleDiskAuditDependencies {
  platform?: NodeJS.Platform;
  run?: Runner;
}

export class OracleDiskAuditService {
  private readonly platform: NodeJS.Platform;
  private readonly run: Runner;

  constructor(dependencies: OracleDiskAuditDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.run = dependencies.run ?? runPrivilegedDiskAudit;
  }

  async audit(input: OracleDiskAuditInput, signal?: AbortSignal): Promise<OracleDiskAuditResult> {
    const unavailable = (
      status: "unavailable" | "permission_required",
      diagnostic: NonNullable<OracleDiskAuditResult["diagnostic"]>,
    ): OracleDiskAuditResult => oracleDiskAuditResultSchema.parse({
      status, privileged: false, group: input.group, start: input.start, count: 0,
      nextStart: null, complete: false, filesystem: null, targets: [],
      measuredBytes: 0, diagnostic,
      warning: "Privileged, read-only Oracle host audit was not completed.",
    });
    if (this.platform !== "linux") return unavailable("unavailable", "execution_failed");
    try {
      const output = await this.run(input, signal);
      let raw: unknown;
      try { raw = JSON.parse(output); }
      catch { return unavailable("unavailable", "invalid_response"); }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return unavailable("unavailable", "invalid_response");
      }
      const result = oracleDiskAuditResultSchema.safeParse({
        ...raw,
        status: "ready",
        privileged: true,
      });
      if (!result.success ||
          result.data.group !== input.group ||
          result.data.start !== input.start ||
          result.data.targets.length > input.limit) {
        return unavailable("unavailable", "invalid_response");
      }
      return result.data;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "ENOENT") return unavailable("permission_required", "helper_missing");
      if (code === "EACCES" || code === "EPERM" || code === "SUDO_DENIED") {
        return unavailable("permission_required", "sudo_permission_required");
      }
      return unavailable("unavailable", "execution_failed");
    }
  }
}

async function runPrivilegedDiskAudit(input: OracleDiskAuditInput, signal?: AbortSignal): Promise<string> {
  const executable = await lstat(HELPER).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error("Root-owned disk-audit helper is not installed."), { code: "ENOENT" });
    }
    throw error;
  });
  if (!executable.isFile() || executable.isSymbolicLink() || executable.uid !== 0 ||
      (executable.mode & 0o022) !== 0) {
    throw Object.assign(new Error("Privileged helper ownership is invalid."), { code: "EACCES" });
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn(SUDO, ["-n", HELPER], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      signal, timeout: TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(output ?? "");
    };
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) {
        child.kill();
        finish(new Error("Disk-audit response exceeds the bound."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > MAX_OUTPUT) {
        child.kill();
        finish(new Error("Disk-audit stderr exceeds the bound."));
      }
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(undefined, stdout);
      } else {
        const denied = /not in the sudoers|a password is required|permission denied|not allowed/iu.test(stderr);
        finish(Object.assign(new Error("Privileged disk audit was not completed."), {
          code: denied ? "SUDO_DENIED" : "AUDIT_FAILED",
        }));
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(JSON.stringify({
      group: input.group, start: input.start, limit: input.limit,
    }));
  });
}
