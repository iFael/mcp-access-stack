import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { LocalAgent } from "../local-agent.js";
import { CampaignRunLease } from "./campaign-run-lease.js";
import { DelegatedCampaignLedger, type CampaignRecord } from "./delegated-campaign-ledger.js";
import type { TypedCampaignCapability } from "./delegated-campaign-coordinator.js";
import type { TrustedCampaignEnrollment } from "./trusted-campaign-agent-lifecycle.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WORKSPACE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const digest = (s: string): string => createHash("sha256").update(s).digest("hex");

interface StoredEnrollment {
  workspaceId: string;
  campaignId: string;
  factoryId: string;
  ownerScopeHash: string;
  definitionDigest: string;
}
interface Catalog {
  version: 1;
  enrollments: StoredEnrollment[];
}
export interface TrustedCampaignBindingFactory {
  /** Provided by trusted host authentication/config, never read from file. */
  readonly ownerScope: string;
  readonly bind: (agent: LocalAgent, record: CampaignRecord) =>
    Promise<ReadonlyMap<string, TypedCampaignCapability>>;
}
export type TrustedCampaignBindingFactories =
  ReadonlyMap<string, TrustedCampaignBindingFactory>;

function same(a: StoredEnrollment, b: StoredEnrollment): boolean {
  return a.workspaceId === b.workspaceId &&
    a.campaignId === b.campaignId &&
    a.factoryId === b.factoryId &&
    a.ownerScopeHash === b.ownerScopeHash &&
    a.definitionDigest === b.definitionDigest;
}
function valid(value: unknown): value is StoredEnrollment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredEnrollment>;
  return Object.keys(item).sort().join(",") ===
      "campaignId,definitionDigest,factoryId,ownerScopeHash,workspaceId" &&
    typeof item.workspaceId === "string" && WORKSPACE.test(item.workspaceId) &&
    typeof item.campaignId === "string" && ID.test(item.campaignId) &&
    typeof item.factoryId === "string" && KEY.test(item.factoryId) &&
    typeof item.ownerScopeHash === "string" && SHA.test(item.ownerScopeHash) &&
    typeof item.definitionDigest === "string" && SHA.test(item.definitionDigest);
}
function checkBindings(plan: CampaignRecord, capabilities: ReadonlyMap<string, TypedCampaignCapability>): void {
  if (!(capabilities instanceof Map) || capabilities.size !== plan.tasks.length) {
    throw new Error("CAMPAIGN_BINDING_MISMATCH: incomplete typed capability factory");
  }
  for (const task of plan.tasks) {
    const c = capabilities.get(task.id);
    if (!c || c.action !== task.action || c.targetResource !== task.targetResource ||
        c.expectedState !== task.expectedState || c.argumentsDigest !== task.argumentsDigest ||
        typeof c.execute !== "function" || typeof c.reconcile !== "function" ||
        typeof c.verify !== "function") {
      throw new Error("CAMPAIGN_BINDING_MISMATCH: enrolled factory does not match persisted task");
    }
  }
}

/**
 * Host-owned durable ENROLLMENT metadata, not permission to dispatch tools.
 * No raw ownerScope, secrets, tool names, typed arguments or arbitrary shell
 * commands are persisted. The trusted host MUST supply code-owned factories
 * again after restart. A missing factory or modified digest fails closed.
 */
export class TrustedCampaignEnrollmentCatalog {
  private readonly file: string;
  private readonly lease: CampaignRunLease;
  constructor(stateDirectory: string, lease: CampaignRunLease = new CampaignRunLease()) {
    if (!path.isAbsolute(stateDirectory)) {
      throw new Error("CAMPAIGN_INVALID: catalog state root must be absolute");
    }
    this.file = path.join(stateDirectory, "delegated-campaign-enrollments.v1.json");
    this.lease = lease;
  }

  private async assertPrivateState(): Promise<void> {
    let info;
    try { info = await lstat(path.dirname(this.file)); }
    catch {
      throw new Error("CAMPAIGN_CATALOG_UNTRUSTED_STATE: missing local private directory");
    }
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error("CAMPAIGN_CATALOG_UNTRUSTED_STATE: directory not private");
    }
  }

  private async readCatalog(): Promise<Catalog> {
    await this.assertPrivateState();
    let info;
    try { info = await lstat(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, enrollments: [] };
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error("CAMPAIGN_CATALOG_UNTRUSTED_STATE: file not private");
    }
    let raw: string;
    try { raw = await readFile(this.file, "utf8"); }
    catch (error) {
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error("CAMPAIGN_CATALOG_INVALID: damaged enrollment file"); }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "enrollments,version") {
      throw new Error("CAMPAIGN_CATALOG_INVALID: unexpected schema");
    }
    const catalog = value as Partial<Catalog>;
    if (catalog.version !== 1 || !Array.isArray(catalog.enrollments) ||
        catalog.enrollments.length > 16 || catalog.enrollments.some(e => !valid(e))) {
      throw new Error("CAMPAIGN_CATALOG_INVALID: unsupported enrollment");
    }
    const seen = new Set<string>();
    for (const e of catalog.enrollments) {
      const k = e.workspaceId + ":" + e.campaignId;
      if (seen.has(k)) throw new Error("CAMPAIGN_CATALOG_INVALID: duplicate campaign identity");
      seen.add(k);
    }
    return catalog as Catalog;
  }

  private async persist(value: Catalog): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp-" + randomBytes(8).toString("hex");
    try {
      const fd = await open(tmp, "wx", 0o600);
      try { await fd.writeFile(JSON.stringify(value) + "\n", "utf8"); await fd.sync(); }
      finally { await fd.close(); }
      await rename(tmp, this.file);
    } finally { await rm(tmp, { force: true }); }
  }

  private async expected(
    agent: LocalAgent,
    input: { workspaceId: string; campaignId: string; factoryId: string },
    factories: TrustedCampaignBindingFactories,
  ): Promise<{ record: StoredEnrollment; enrollment: TrustedCampaignEnrollment }> {
    if (!WORKSPACE.test(input.workspaceId) || !ID.test(input.campaignId) ||
        !KEY.test(input.factoryId)) throw new Error("CAMPAIGN_INVALID: enrollment identifier");
    const factory = factories.get(input.factoryId);
    if (!factory || typeof factory.ownerScope !== "string" ||
        factory.ownerScope.length < 1 || factory.ownerScope.length > 256 ||
        typeof factory.bind !== "function") {
      throw new Error("CAMPAIGN_FACTORY_NOT_TRUSTED");
    }
    // Validate that the workspace exists under the agent's current policy.
    agent.resolveWorkspaceConcurrencyKey(input.workspaceId);
    const ledger = new DelegatedCampaignLedger(path.dirname(this.file), factory.ownerScope);
    const plan = await ledger.get(input.workspaceId, input.campaignId);
    if (!plan) throw new Error("CAMPAIGN_NOT_ENROLLED: missing authorized plan");
    checkBindings(plan, await factory.bind(agent, plan));
    const record: StoredEnrollment = {
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      factoryId: input.factoryId,
      ownerScopeHash: digest(factory.ownerScope),
      definitionDigest: plan.definitionDigest,
    };
    return {
      record,
      enrollment: {
        workspaceId: input.workspaceId, campaignId: input.campaignId,
        ownerScope: factory.ownerScope, bind: factory.bind,
      },
    };
  }

  /**
   * Called only by code-owned trusted enrollment workflows, never by a
   * user-controlled MCP tool. Identity cannot be edited after enrollment.
   */
  async enroll(
    agent: LocalAgent,
    input: { workspaceId: string; campaignId: string; factoryId: string },
    factories: TrustedCampaignBindingFactories,
  ): Promise<void> {
    const expected = await this.expected(agent, input, factories);
    await this.assertPrivateState();
    await this.lease.run(this.file + ".lock", async () => {
      const current = await this.readCatalog();
      const old = current.enrollments.find(e =>
        e.workspaceId === input.workspaceId && e.campaignId === input.campaignId);
      if (old) {
        if (!same(old, expected.record)) throw new Error("CAMPAIGN_CATALOG_CONFLICT");
        return;
      }
      if (current.enrollments.length >= 16) throw new Error("CAMPAIGN_CATALOG_FULL");
      current.enrollments.push(expected.record);
      await this.persist(current);
    });
  }

  async load(
    agent: LocalAgent,
    factories: TrustedCampaignBindingFactories,
  ): Promise<readonly TrustedCampaignEnrollment[]> {
    const catalog = await this.readCatalog();
    const result: TrustedCampaignEnrollment[] = [];
    for (const saved of catalog.enrollments) {
      const restored = await this.expected(agent, {
        workspaceId: saved.workspaceId, campaignId: saved.campaignId,
        factoryId: saved.factoryId,
      }, factories);
      if (!same(saved, restored.record)) {
        throw new Error("CAMPAIGN_CATALOG_CONFLICT: owner, plan, or factory changed");
      }
      result.push(restored.enrollment);
    }
    return result;
  }
}
