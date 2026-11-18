import { appendFile, copyFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { AppError, policyFileSchema, type PolicyFile, type SourceControlCapability } from "@vs-code-gpt/shared";
import { WorkspaceRegistry } from "./workspace-registry.js";


/** Strictly scoped Oracle capability grants; callers never choose a path or capability. */
type OracleGrantCapability = "github.pull_request.ready" | "git.worktree.write";
type OracleGrantStatus = "not_granted" | "granted" | "already_granted";

export interface OracleGrantResult<C extends OracleGrantCapability> {
  status: OracleGrantStatus;
  workspaceId: "mcp-access-stack";
  capability: C;
  policySha256: string;
  effective: boolean;
  backupCreated: boolean;
}

class FixedOraclePolicyGrant<C extends OracleGrantCapability> {
  private static readonly activePaths = new Set<string>();

  constructor(
    private readonly policyPath: string,
    private readonly auditPath: string,
    private readonly effective: () => boolean,
    private readonly onApplied: () => Promise<void>,
    private readonly capability: C,
    private readonly prerequisite: SourceControlCapability,
    private readonly auditLabel: "ready" | "worktree",
  ) {}

  async inspect(): Promise<OracleGrantResult<C>> {
    const current = await this.readCurrent();
    return this.result(current.sha256, current.granted ? "granted" : "not_granted", false);
  }

  async grant(input: {
    expectedPolicySha256: string;
    operationId: string;
    actor: string;
  }): Promise<OracleGrantResult<C>> {
    if (FixedOraclePolicyGrant.activePaths.has(this.policyPath)) {
      throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "An Oracle policy grant is already running.");
    }
    FixedOraclePolicyGrant.activePaths.add(this.policyPath);
    const tempPath = `${this.policyPath}.${input.operationId}.${this.auditLabel}.tmp`;
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
      if (!workspace?.enabled || workspace.permissionProfile !== "full-repo-write" ||
          !workspace.sourceControl?.capabilities.includes(this.prerequisite)) {
        throw new AppError("PERMISSION_DENIED", "Oracle grant requires an existing trusted source-control capability.");
      }
      // Preserve unrelated fields: schema parsing may inject defaults.
      const next = JSON.parse(current.bytes.toString("utf8")) as PolicyFile;
      const target = next.workspaces.find((item) => item.id === "mcp-access-stack")!;
      target.sourceControl!.capabilities.push(this.capability);
      await WorkspaceRegistry.fromPolicy(next);
      const contents = Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8");
      const nextSha = createHash("sha256").update(contents).digest("hex");
      await appendFile(this.auditPath, JSON.stringify({
        event: `oracle_${this.auditLabel}_grant_requested`, operationId: input.operationId,
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
      if ((await this.readCurrent()).sha256 !== current.sha256) {
        throw new AppError("GIT_HEAD_MISMATCH", "Oracle policy changed while preparing the grant.");
      }
      const backupPath = `${this.policyPath}.backup-${this.auditLabel}-${input.operationId}.json`;
      const backup = await open(backupPath, "wx", 0o600);
      try {
        await backup.writeFile(current.bytes);
        await backup.sync();
      } finally {
        await backup.close();
      }
      await rename(tempPath, this.policyPath);
      // Reload in-process so no Edge connection is restarted.
      await this.onApplied();
      if (!this.effective()) {
        throw new AppError("PERMISSION_DENIED", "Oracle policy reload did not activate the granted capability.");
      }
      await appendFile(this.auditPath, JSON.stringify({
        event: `oracle_${this.auditLabel}_grant_applied`, operationId: input.operationId,
        policySha256: nextSha, timestamp: new Date().toISOString(),
      }) + "\n", { mode: 0o600 });
      return this.result(nextSha, "granted", true);
    } finally {
      FixedOraclePolicyGrant.activePaths.delete(this.policyPath);
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
      granted: workspace.sourceControl?.capabilities.includes(this.capability) ?? false,
    };
  }

  private result(policySha256: string, status: OracleGrantStatus, backupCreated: boolean): OracleGrantResult<C> {
    return {
      status, workspaceId: "mcp-access-stack",
      capability: this.capability, policySha256, effective: this.effective(), backupCreated,
    };
  }
}

/** Existing public grant, unchanged in capabilities and constructor contract. */
export class ReadyReviewPolicyGrant extends FixedOraclePolicyGrant<"github.pull_request.ready"> {
  constructor(policyPath: string, auditPath: string, effective: () => boolean, onApplied: () => Promise<void>) {
    super(policyPath, auditPath, effective, onApplied,
      "github.pull_request.ready", "github.pull_request.merge", "ready");
  }
}

/** One additional fixed capability for clean, registered Git worktrees only. */
export class WorktreePolicyGrant extends FixedOraclePolicyGrant<"git.worktree.write"> {
  constructor(policyPath: string, auditPath: string, effective: () => boolean, onApplied: () => Promise<void>) {
    super(policyPath, auditPath, effective, onApplied,
      "git.worktree.write", "git.branch.write", "worktree");
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
