import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "@vs-code-gpt/shared";
import { CampaignRunLease } from "./campaign-run-lease.js";

/**
 * Internal, non-executing campaign ledger. A claim is an authorization-bound
 * reservation, never permission to bypass the typed capability's own gates.
 * The owner-specific state directory must be supplied by the trusted agent.
 */
export const CAMPAIGN_ACTIONS = [
  "inspect", "edit", "test", "commit", "push", "pr", "ci",
  "merge", "deploy", "release", "reprovision", "rotate", "revoke",
] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];
export type CampaignTaskState =
  | "pending" | "in_flight" | "outcome_unknown" | "completed" | "blocked" | "failed";
export type CampaignProof = { kind: "verified"; reference: string };
export interface CampaignStep {
  id: string;
  action: CampaignAction;
  dependsOn: string[];
  /** Bound identity of the resource the trusted typed capability may touch. */
  targetResource: string;
  /** Opaque exact-state/CAS precondition; must be rechecked by the real capability. */
  expectedState: string;
  /** SHA-256 of the canonical typed operation arguments, NOT arbitrary shell text. */
  argumentsDigest: string;
}
export interface DelegatedCampaignInput {
  campaignId: string;
  workspaceId: string;
  objective: string;
  authorizedActions: CampaignAction[];
  tasks: CampaignStep[];
}
export interface CampaignTask extends CampaignStep {
  state: CampaignTaskState;
  operationId?: string;
  proof?: CampaignProof;
}
export interface CampaignRecord {
  version: 1;
  campaignId: string;
  workspaceId: string;
  ownerScopeHash: string;
  definitionDigest: string;
  objective: string;
  authorizedActions: CampaignAction[];
  tasks: CampaignTask[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export type CampaignClaim =
  | { disposition: "claimed"; taskId: string; operationId: string; campaign: CampaignRecord }
  | { disposition: "no_runnable_step"; campaign: CampaignRecord };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TASK_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const WORKSPACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const BOUND_VALUE = /^[a-zA-Z0-9][a-zA-Z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set<string>(CAMPAIGN_ACTIONS);
const STATES = new Set<string>(["pending","in_flight","outcome_unknown","completed","blocked","failed"]);

function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error("CAMPAIGN_INVALID: " + message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function normalize(input: DelegatedCampaignInput): DelegatedCampaignInput {
  ensure(UUID.test(input.campaignId), "campaignId must be a lowercase UUID");
  ensure(WORKSPACE_ID.test(input.workspaceId), "invalid workspaceId");
  ensure(typeof input.objective === "string" && input.objective.length > 0 && input.objective.length <= 4000, "invalid objective");
  ensure(redactSensitiveText(input.objective) === input.objective, "objective must not contain secret material");
  ensure(Array.isArray(input.authorizedActions) && input.authorizedActions.length > 0 && input.authorizedActions.length <= CAMPAIGN_ACTIONS.length, "invalid authorization");
  ensure(Array.isArray(input.tasks) && input.tasks.length > 0 && input.tasks.length <= 64, "invalid task count");
  const permissions = new Set(input.authorizedActions);
  ensure(permissions.size === input.authorizedActions.length && [...permissions].every(x => ACTIONS.has(x)), "invalid permissions");
  const ids = new Set<string>();
  for (const task of input.tasks) {
    ensure(TASK_ID.test(task.id) && !ids.has(task.id), "invalid/duplicate task id");
    ensure(ACTIONS.has(task.action) && permissions.has(task.action), "task outside delegated authorization");
    ensure(typeof task.targetResource === "string" && BOUND_VALUE.test(task.targetResource) &&
      !task.targetResource.includes(".."), "invalid target resource");
    ensure(typeof task.expectedState === "string" && BOUND_VALUE.test(task.expectedState) &&
      !task.expectedState.includes(".."), "invalid expected state");
    ensure(typeof task.argumentsDigest === "string" && SHA256.test(task.argumentsDigest),
      "invalid typed arguments digest");
    ensure(Array.isArray(task.dependsOn) && task.dependsOn.length <= 64, "invalid dependencies");
    ids.add(task.id);
  }
  const byId = new Map(input.tasks.map(task => [task.id, task]));
  for (const task of input.tasks) {
    ensure(new Set(task.dependsOn).size === task.dependsOn.length, "duplicate dependency");
    for (const dep of task.dependsOn) ensure(byId.has(dep) && dep !== task.id, "missing/self dependency");
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    ensure(!visiting.has(id), "dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of input.tasks) visit(task.id);
  return {
    ...input,
    objective: redactSensitiveText(input.objective),
    authorizedActions: [...permissions].sort(),
    tasks: input.tasks.map(t => ({
      id: t.id, action: t.action, dependsOn: [...t.dependsOn].sort(),
      targetResource: t.targetResource, expectedState: t.expectedState,
      argumentsDigest: t.argumentsDigest,
    })),
  };
}
function parsePersisted(value: unknown, ownerScopeHash: string): CampaignRecord {
  ensure(isRecord(value) && value.version === 1, "invalid persisted record");
  ensure(value.ownerScopeHash === ownerScopeHash, "owner scope mismatch");
  ensure(typeof value.objective === "string" && typeof value.definitionDigest === "string" && /^[a-f0-9]{64}$/u.test(value.definitionDigest), "invalid campaign");
  ensure(typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0, "invalid revision");
  ensure(typeof value.createdAt === "string" && typeof value.updatedAt === "string", "invalid timestamps");
  const input = normalize({
    campaignId: value.campaignId as string,
    workspaceId: value.workspaceId as string,
    objective: value.objective,
    authorizedActions: value.authorizedActions as CampaignAction[],
    tasks: value.tasks as CampaignStep[],
  });
  ensure(value.definitionDigest === hash(JSON.stringify(input)), "persisted authorization/plan digest mismatch");
  ensure(Array.isArray(value.tasks) && value.tasks.length === input.tasks.length, "invalid tasks");
  const tasks: CampaignTask[] = value.tasks.map((t: unknown, i: number) => {
    ensure(isRecord(t) && STATES.has(String(t.state)), "invalid persisted task state");
    const base = input.tasks[i]!;
    ensure(t.id === base.id && t.action === base.action &&
      JSON.stringify(t.dependsOn) === JSON.stringify(base.dependsOn) &&
      t.targetResource === base.targetResource && t.expectedState === base.expectedState &&
      t.argumentsDigest === base.argumentsDigest, "task definition mismatch");
    const state = t.state as CampaignTaskState;
    if (state !== "pending") ensure(typeof t.operationId === "string" && UUID.test(t.operationId), "missing operation identity");
    if (state === "pending") ensure(t.operationId === undefined, "unclaimed task has operationId");
    if (state === "completed" || t.proof !== undefined) {
      ensure(isRecord(t.proof) && t.proof.kind === "verified" &&
        typeof t.proof.reference === "string" && t.proof.reference.length > 0 &&
        t.proof.reference.length <= 300, "invalid proof");
    }
    return { ...base, state, ...(t.operationId === undefined ? {} : { operationId: t.operationId as string }), ...(t.proof === undefined ? {} : { proof: t.proof as CampaignProof }) };
  });
  return {
    version: 1, campaignId: input.campaignId, workspaceId: input.workspaceId,
    ownerScopeHash, definitionDigest: value.definitionDigest as string,
    objective: input.objective, authorizedActions: input.authorizedActions,
    tasks, revision: value.revision as number, createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  };
}
export class DelegatedCampaignLedger {
  private readonly directory: string;
  private readonly ownerScopeHash: string;
  private readonly runLease: CampaignRunLease;
  constructor(stateDirectory: string, ownerScope: string, runLease?: CampaignRunLease) {
    ensure(path.isAbsolute(stateDirectory), "state directory must be absolute");
    ensure(ownerScope.length > 0, "owner scope required");
    this.directory = path.join(stateDirectory, "delegated-campaigns");
    this.ownerScopeHash = hash(ownerScope);
    this.runLease = runLease ?? new CampaignRunLease();
  }
  private file(workspaceId: string, id: string): string {
    ensure(WORKSPACE_ID.test(workspaceId) && UUID.test(id), "invalid record identity");
    return path.join(this.directory, hash([this.ownerScopeHash, workspaceId, id].join(":")) + ".json");
  }
  private async read(workspaceId: string, id: string): Promise<CampaignRecord | undefined> {
    let text: string;
    try { text = await readFile(this.file(workspaceId, id), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return parsePersisted(JSON.parse(text) as unknown, this.ownerScopeHash);
  }
  async get(workspaceId: string, id: string): Promise<CampaignRecord | undefined> {
    return this.read(workspaceId, id);
  }
  private async locked<T>(workspaceId: string, id: string, fn: () => Promise<T>): Promise<T> {
    // The short ledger CAS/write lock uses the same conservative process-death
    // recovery as the long campaign run lock. No reset or stale-lock shortcut.
    return this.runLease.run(this.file(workspaceId, id) + ".lock", fn);
  }
  private async write(record: CampaignRecord): Promise<void> {
    const target = this.file(record.workspaceId, record.campaignId);
    const temp = target + ".tmp-" + randomBytes(8).toString("hex");
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temp, target); }
    catch (error) { await rm(temp, { force: true }); throw error; }
  }
  /** Single run per campaign with a recoverable same-host lease. */
  async withExclusiveRun<T>(
    workspaceId: string, id: string, run: () => Promise<T>,
  ): Promise<T> {
    const lockPath = this.file(workspaceId, id) + ".run.lock";
    return this.runLease.run(lockPath, run);
  }

  async create(input: DelegatedCampaignInput): Promise<CampaignRecord> {
    const normalized = normalize(input);
    const digest = hash(JSON.stringify(normalized));
    return this.locked(normalized.workspaceId, normalized.campaignId, async () => {
      const old = await this.read(normalized.workspaceId, normalized.campaignId);
      if (old) {
        ensure(old.definitionDigest === digest, "campaignId reused with different objective/authorization");
        return old;
      }
      const at = new Date().toISOString();
      const record: CampaignRecord = {
        version: 1, campaignId: normalized.campaignId, workspaceId: normalized.workspaceId,
        ownerScopeHash: this.ownerScopeHash, definitionDigest: digest,
        objective: normalized.objective, authorizedActions: normalized.authorizedActions,
        tasks: normalized.tasks.map(t => ({ ...t, state: "pending" })),
        revision: 0, createdAt: at, updatedAt: at,
      };
      await this.write(record);
      return record;
    });
  }
  async claimNext(workspaceId: string, id: string): Promise<CampaignClaim> {
    return this.locked(workspaceId, id, async () => {
      const record = await this.read(workspaceId, id);
      ensure(record, "campaign not found");
      // Conservative default: only one active mutation per campaign. When
      // its outcome is unknown, independent branches can still progress.
      if (record.tasks.some(t => t.state === "in_flight")) {
        return { disposition: "no_runnable_step", campaign: record };
      }
      const available = record.tasks.find(t =>
        t.state === "pending" &&
        t.dependsOn.every(dep => record.tasks.find(d => d.id === dep)?.state === "completed") &&
        !record.tasks.some(other => other.id !== t.id &&
          (other.state === "outcome_unknown" || other.state === "blocked") &&
          other.targetResource === t.targetResource),
      );
      if (!available) return { disposition: "no_runnable_step", campaign: record };
      available.state = "in_flight";
      available.operationId = randomUUID();
      record.revision++;
      record.updatedAt = new Date().toISOString();
      await this.write(record);
      return { disposition: "claimed", taskId: available.id, operationId: available.operationId, campaign: record };
    });
  }
  async transition(
    workspaceId: string, id: string, taskId: string, operationId: string,
    next: "completed" | "failed" | "blocked" | "outcome_unknown",
    proof?: CampaignProof,
  ): Promise<CampaignRecord> {
    return this.locked(workspaceId, id, async () => {
      const record = await this.read(workspaceId, id);
      ensure(record, "campaign not found");
      const task = record.tasks.find(t => t.id === taskId);
      ensure(task && task.operationId === operationId && UUID.test(operationId), "operation identity mismatch");
      ensure(task.state === "in_flight" || task.state === "outcome_unknown", "task is not reconcilable");
      ensure(task.state !== "outcome_unknown" || next !== "outcome_unknown", "duplicate uncertain transition");
      const needsEvidence = next === "completed" || task.state === "outcome_unknown";
      ensure(!needsEvidence || (proof?.kind === "verified" && typeof proof.reference === "string" && proof.reference.length > 0 && proof.reference.length <= 300), "reconciled/completed task requires bounded verified evidence");
      task.state = next;
      if (proof?.kind === "verified") task.proof = proof;
      record.revision++;
      record.updatedAt = new Date().toISOString();
      await this.write(record);
      return record;
    });
  }
}
