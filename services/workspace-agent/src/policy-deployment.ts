import { appendFile, copyFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { AppError, policyFileSchema, type PolicyFile } from "@vs-code-gpt/shared";
import { WorkspaceRegistry } from "./workspace-registry.js";


/**
 * Narrow Oracle administration: grants one fixed, less-privileged GitHub
 * capability to the existing stack workspace. No caller-selected paths,
 * workspace IDs, or capabilities are accepted.
 */
export class ReadyReviewPolicyGrant {
  private busy = false;

  constructor(
    private readonly policyPath: string,
    private readonly auditPath: string,
    private readonly effective: () => boolean,
    private readonly onApplied: () => Promise<void>,
  ) {}

  async inspect(): Promise<{
    status: "not_granted" | "granted" | "already_granted";
    workspaceId: "mcp-access-stack";
    capability: "github.pull_request.ready";
    policySha256: string;
    effective: boolean;
    backupCreated: boolean;
  }> {
    const current = await this.readCurrent();
    return this.result(current.sha256, current.granted ? "granted" : "not_granted", false);
  }

  async grant(input: {
    expectedPolicySha256: string;
    operationId: string;
    actor: string;
  }): Promise<Awaited<ReturnType<ReadyReviewPolicyGrant["inspect"]>>> {
    if (this.busy) throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "An Oracle policy grant is already running.");
    this.busy = true;
    const tempPath = `${this.policyPath}.${input.operationId}.ready.tmp`;
    try {
      const current = await this.readCurrent();
      if (current.granted) {
        if (!this.effective()) await this.onApplied();
        return this.result(current.sha256, "already_granted", false);
      }
      if (current.sha256 !== input.expectedPolicySha256) {
        throw new AppError("GIT_HEAD_MISMATCH", "Oracle policy SHA changed; inspect before retrying.");
      }
      const workspace = current.policy.workspaces.find((item) => item.id === "mcp-access-stack");
      if (!workspace?.enabled || !workspace.sourceControl?.capabilities.includes("github.pull_request.merge")) {
        throw new AppError("PERMISSION_DENIED", "Ready-for-review grant requires the existing trusted merge capability.");
      }
      // Mutate the original validated JSON, not the schema-normalized policy:
      // parsing injects defaults and would rewrite unrelated policy fields.
      const next = JSON.parse(current.bytes.toString("utf8")) as PolicyFile;
      const target = next.workspaces.find((item) => item.id === "mcp-access-stack")!;
      target.sourceControl!.capabilities.push("github.pull_request.ready");
      await WorkspaceRegistry.fromPolicy(next);
      const contents = Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8");
      const nextSha = createHash("sha256").update(contents).digest("hex");
      // The audit must be writable before any file changes; never log policy
      // contents, OAuth assertions or other credentials.
      await appendFile(this.auditPath, JSON.stringify({
        event: "oracle_ready_grant_requested", operationId: input.operationId,
        actorHash: createHash("sha256").update(input.actor).digest("hex"),
        expectedPolicySha256: current.sha256, nextPolicySha256: nextSha,
        timestamp: new Date().toISOString(),
      }) + "\n", { mode: 0o600 });
      const fd = await open(tempPath, "wx", 0o600);
      try {
        await fd.writeFile(contents);
        await fd.sync();
      } finally {
        await fd.close();
      }
      await validatePolicyFile(tempPath);
      const checked = await this.readCurrent();
      if (checked.sha256 !== current.sha256) {
        throw new AppError("GIT_HEAD_MISMATCH", "Oracle policy changed while preparing the grant.");
      }
      const backupPath = `${this.policyPath}.backup-ready-${input.operationId}.json`;
      const backup = await open(backupPath, "wx", 0o600);
      try {
        await backup.writeFile(current.bytes);
        await backup.sync();
      } finally {
        await backup.close();
      }
      await rename(tempPath, this.policyPath);
      // In-process policy reload is safer than restarting the Edge connector,
      // as there is no loss of the established trusted Edge session.
      await this.onApplied();
      if (!this.effective()) {
        throw new AppError("PERMISSION_DENIED", "Oracle policy reload did not activate the granted capability.");
      }
      await appendFile(this.auditPath, JSON.stringify({
        event: "oracle_ready_grant_applied", operationId: input.operationId,
        policySha256: nextSha, timestamp: new Date().toISOString(),
      }) + "\n", { mode: 0o600 });
      return this.result(nextSha, "granted", true);
    } finally {
      this.busy = false;
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async readCurrent(): Promise<{
    bytes: Buffer;
    policy: PolicyFile;
    sha256: string;
    granted: boolean;
  }> {
    const state = await lstat(this.policyPath);
    if (!state.isFile() || state.isSymbolicLink() ||
        (process.platform !== "win32" && (state.mode & 0o777) !== 0o600) ||
        (typeof process.getuid === "function" && state.uid !== process.getuid())) {
      throw new AppError("PERMISSION_DENIED", "Oracle policy ownership or mode is not secure.");
    }
    const bytes = await readFile(this.policyPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let data: unknown;
    try {
      data = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new AppError("POLICY_INVALID", "Oracle policy is not valid JSON.");
    }
    const policy = policyFileSchema.parse(data);
    const workspace = policy.workspaces.find((item) => item.id === "mcp-access-stack");
    if (!workspace || !workspace.enabled) {
      throw new AppError("WORKSPACE_NOT_FOUND", "Trusted Oracle stack workspace is missing or disabled.");
    }
    return {
      bytes, sha256, policy,
      granted: workspace.sourceControl?.capabilities.includes("github.pull_request.ready") ?? false,
    };
  }

  private result(
    policySha256: string,
    status: "not_granted" | "granted" | "already_granted",
    backupCreated: boolean,
  ) {
    return {
      status, workspaceId: "mcp-access-stack" as const,
      capability: "github.pull_request.ready" as const,
      policySha256, effective: this.effective(), backupCreated,
    };
  }
}

export interface PolicyValidationResult {
  path: string;
  workspaceCount: number;
}

export interface PolicyApplyResult extends PolicyValidationResult {
  targetPath: string;
  backupPath?: string;
}

export async function validatePolicyFile(
  policyPath: string,
): Promise<PolicyValidationResult> {
  const absolutePath = path.resolve(policyPath);
  const registry = await WorkspaceRegistry.load(absolutePath);
  return {
    path: absolutePath,
    workspaceCount: registry.all().length,
  };
}

export async function applyPolicyFile(
  sourcePath: string,
  targetPath: string,
): Promise<PolicyApplyResult> {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (samePath(source, target)) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Policy source and target must be different files.",
    );
  }

  const validation = await validatePolicyFile(source);
  const contents = await readFile(source);
  const targetDirectory = path.dirname(target);
  await mkdir(targetDirectory, { recursive: true });

  const temporaryPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  const lastKnownGoodPath = `${target}.last-known-good.json`;
  let backupPath: string | undefined;

  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await validatePolicyFile(temporaryPath);

    if (await fileExists(target)) {
      backupPath = `${target}.backup-${timestampForFileName()}.json`;
      await copyFile(target, backupPath);
      await copyFile(target, lastKnownGoodPath);
    }

    await rename(temporaryPath, target);
    await validatePolicyFile(target);
    return {
      ...validation,
      targetPath: target,
      ...(backupPath === undefined ? {} : { backupPath }),
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function timestampForFileName(): string {
  return new Date().toISOString().replaceAll(":", "-");
}
