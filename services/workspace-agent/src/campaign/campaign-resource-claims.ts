import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { CampaignRunLease } from "./campaign-run-lease.js";
import type { CampaignRecord } from "./delegated-campaign-ledger.js";

type ResourceClaim = {
  version: 1;
  workspaceKeyDigest: string;
  ownerScopeHash: string;
  campaignId: string;
  definitionDigest: string;
};
const MUTATION_EXEMPT = new Set(["inspect", "ci"]);
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digest = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * A durable workspace-wide reservation for campaigns with mutations.
 * It is deliberately more conservative than an individual Git root:
 * two campaigns cannot mutate aliases of the same canonical workspace.
 * Read-only inspect/ci campaigns do not reserve the workspace.
 *
 * All hosts MUST share this trusted, local state directory. This is not a
 * distributed lock and does not authorize cross-host shared filesystem use.
 */
export class CampaignResourceClaims {
  private readonly directory: string;
  private readonly mutex: CampaignRunLease;

  constructor(stateDirectory: string, mutex: CampaignRunLease = new CampaignRunLease()) {
    if (!path.isAbsolute(stateDirectory)) {
      throw new Error("CAMPAIGN_INVALID: resource claim directory must be absolute");
    }
    this.directory = path.join(stateDirectory, "delegated-campaign-resource-claims");
    this.mutex = mutex;
  }

  private file(workspaceKey: string): string {
    if (!path.isAbsolute(workspaceKey)) throw new Error("CAMPAIGN_INVALID: canonical workspace root");
    return path.join(this.directory, digest(workspaceKey) + ".json");
  }
  private expected(workspaceKey: string, record: CampaignRecord): ResourceClaim {
    if (!SHA.test(record.ownerScopeHash) || !SHA.test(record.definitionDigest) ||
        !UUID.test(record.campaignId)) throw new Error("CAMPAIGN_INVALID: persistently bound identity");
    return {
      version: 1,
      workspaceKeyDigest: digest(workspaceKey),
      ownerScopeHash: record.ownerScopeHash,
      campaignId: record.campaignId,
      definitionDigest: record.definitionDigest,
    };
  }
  private async withMutex<T>(task: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return this.mutex.run(path.join(this.directory, ".admission.lock"), task);
  }
  private async read(file: string): Promise<unknown> {
    try { return JSON.parse(await readFile(file, "utf8")) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("CAMPAIGN_RESOURCE_CLAIM_INVALID");
    }
  }
  private matches(actual: unknown, expected: ResourceClaim): boolean {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const a = actual as Partial<ResourceClaim>;
    return a.version === 1 &&
      a.workspaceKeyDigest === expected.workspaceKeyDigest &&
      a.ownerScopeHash === expected.ownerScopeHash &&
      a.campaignId === expected.campaignId &&
      a.definitionDigest === expected.definitionDigest;
  }

  static needsReservation(plan: CampaignRecord): boolean {
    return plan.tasks.some(task => !MUTATION_EXEMPT.has(task.action));
  }

  async reserve(workspaceKey: string, record: CampaignRecord): Promise<void> {
    if (!CampaignResourceClaims.needsReservation(record)) return;
    const expected = this.expected(workspaceKey, record);
    const file = this.file(workspaceKey);
    await this.withMutex(async () => {
      const prior = await this.read(file);
      if (prior !== undefined) {
        if (!this.matches(prior, expected)) {
          throw new Error("CAMPAIGN_RESOURCE_CONFLICT: another campaign holds the workspace");
        }
        return;
      }
      const f = await open(file, "wx", 0o600);
      try {
        await f.writeFile(JSON.stringify(expected) + "\n", "utf8");
        await f.sync();
      } finally { await f.close(); }
    });
  }

  /** Only completion VERIFIED in the durable ledger releases a reservation. */
  async releaseCompleted(workspaceKey: string, record: CampaignRecord): Promise<void> {
    if (!CampaignResourceClaims.needsReservation(record)) return;
    if (!record.tasks.every(task => task.state === "completed" &&
        task.proof?.kind === "verified")) {
      throw new Error("CAMPAIGN_RESOURCE_INCOMPLETE: cannot release unfinished workspace");
    }
    const expected = this.expected(workspaceKey, record);
    await this.withMutex(async () => {
      const file = this.file(workspaceKey);
      const prior = await this.read(file);
      // A completed campaign may have released its claim already, allowing
      // the next campaign to acquire the SAME canonical workspace.
      if (prior === undefined) return;
      if (!this.matches(prior, expected)) {
        if (prior !== null && typeof prior === "object" && !Array.isArray(prior)) {
          const other = prior as Partial<ResourceClaim>;
          if (other.version === 1 &&
              other.workspaceKeyDigest === expected.workspaceKeyDigest &&
              typeof other.campaignId === "string" && UUID.test(other.campaignId) &&
              other.campaignId !== expected.campaignId &&
              typeof other.ownerScopeHash === "string" && SHA.test(other.ownerScopeHash) &&
              typeof other.definitionDigest === "string" && SHA.test(other.definitionDigest)) {
            // Never remove another campaign's valid reservation.
            return;
          }
        }
        throw new Error("CAMPAIGN_RESOURCE_CLAIM_MISMATCH");
      }
      await rm(file);
    });
  }
}
