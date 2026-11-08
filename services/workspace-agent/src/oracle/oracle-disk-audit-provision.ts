import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import {
  ORACLE_DISK_AUDIT_PINNED_SHA256,
  type OracleDiskAuditProvisionInput,
  type OracleDiskAuditProvisionResult,
} from "@vs-code-gpt/shared";

const BOOTSTRAP = "/usr/local/libexec/mcp-v3-root-provision-disk-audit";
const HELPER = "/usr/local/libexec/mcp-v3-disk-audit";
const MODULE = "/usr/local/libexec/mcp-v3-disk-audit.mjs";
const READY_MARKER = "/usr/local/libexec/mcp-v3-disk-audit.ready";
const SOURCE = "/var/lib/mcp-access-stack/current/tooling/oracle-disk-audit.mjs";

type InstallRunner = (signal?: AbortSignal) => Promise<string>;
type InspectRootFile = (path: string) => Promise<boolean>;
type SourceDigest = () => Promise<string | null>;

export interface OracleDiskAuditProvisionDependencies {
  platform?: NodeJS.Platform;
  inspectRootFile?: InspectRootFile;
  sourceDigest?: SourceDigest;
  runInstall?: InstallRunner;
}

async function hasTrustedRootFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EACCES") return null;
    throw error;
  });
  return info !== null && info.isFile() && !info.isSymbolicLink() &&
    info.uid === 0 && (info.mode & 0o022) === 0;
}

async function readSourceDigest(): Promise<string | null> {
  const info = await lstat(SOURCE).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EACCES") return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) return null;
  const bytes = await readFile(SOURCE);
  return createHash("sha256").update(bytes).digest("hex");
}

function privilegedInstall(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-n", BOOTSTRAP], {
      shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      timeout: 40_000, signal,
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
    child.on("error", error => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 8_192) {
        child.kill();
        finish(new Error("Provision result exceeded limit."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > 8_192) {
        child.kill();
        finish(new Error("Provision error output exceeded limit."));
      }
    });
    child.on("close", code => {
      if (code === 0) {
        finish(undefined, stdout);
      } else {
        const denied = /not allowed|not in the sudoers|a password is required|permission denied/iu.test(stderr);
        finish(Object.assign(new Error("Bounded root provisioner did not complete."), {
          code: denied ? "EACCES" : "EXECUTION_FAILED",
        }));
      }
    });
  });
}

/** Fixed Oracle product, pinned source hash, never user-selected paths or commands. */
export class OracleDiskAuditProvisionService {
  private readonly platform: NodeJS.Platform;
  private readonly inspectRootFile: InspectRootFile;
  private readonly sourceDigest: SourceDigest;
  private readonly runInstall: InstallRunner;

  constructor(deps: OracleDiskAuditProvisionDependencies = {}) {
    this.platform = deps.platform ?? process.platform;
    this.inspectRootFile = deps.inspectRootFile ?? hasTrustedRootFile;
    this.sourceDigest = deps.sourceDigest ?? readSourceDigest;
    this.runInstall = deps.runInstall ?? privilegedInstall;
  }

  async execute(input: OracleDiskAuditProvisionInput, signal?: AbortSignal):
    Promise<OracleDiskAuditProvisionResult> {
    const result = (status: OracleDiskAuditProvisionResult["status"],
      bootstrapPresent: boolean, auditPresent: boolean,
      diagnostic?: OracleDiskAuditProvisionResult["diagnostic"]): OracleDiskAuditProvisionResult => ({
      status,
      bootstrapPresent,
      auditPresent,
      pinnedSourceSha256: ORACLE_DISK_AUDIT_PINNED_SHA256,
      ...(input.action === "install" ? { operationId: input.operationId } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    });
    if (this.platform !== "linux") return result("unavailable", false, false, "linux_only");
    const bootstrap = await this.inspectRootFile(BOOTSTRAP);
    const audit = await this.inspectRootFile(HELPER) &&
      await this.inspectRootFile(MODULE) &&
      await this.inspectRootFile(READY_MARKER);
    if (input.action === "inspect") {
      return result(audit ? "installed" : bootstrap ? "ready" : "bootstrap_required", bootstrap, audit);
    }
    if (audit) return result("already_installed", bootstrap, true);
    if (!bootstrap) return result("bootstrap_required", false, false, "host_root_bootstrap_required");
    const currentSha = await this.sourceDigest();
    if (currentSha !== ORACLE_DISK_AUDIT_PINNED_SHA256) {
      return result("unavailable", true, false, "source_hash_mismatch");
    }
    try {
      const output = JSON.parse(await this.runInstall(signal)) as unknown;
      if (!output || typeof output !== "object" || Array.isArray(output) ||
          (output as Record<string, unknown>).status !== "installed" ||
          (output as Record<string, unknown>).capability !== "disk-audit-read-only") {
        return result("unavailable", true, false, "invalid_install_receipt");
      }
      const verified = await this.inspectRootFile(HELPER) &&
        await this.inspectRootFile(MODULE) &&
        await this.inspectRootFile(READY_MARKER);
      return result(verified ? "installed" : "unavailable", true, verified,
        verified ? undefined : "installed_files_unverified");
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "EACCES" || code === "EPERM") {
        return result("permission_required", true, false, "root_policy_denied");
      }
      // The root action may have committed before disconnection/timeout.
      // Force inspect/reconciliation rather than launching a second install.
      return result("outcome_unknown", true, false, "inspect_before_retry");
    }
  }
}
