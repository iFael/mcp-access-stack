import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DelegatedCampaignLedger, type CampaignStep } from "./delegated-campaign-ledger.js";
import { DelegatedCampaignCoordinator, type TypedCampaignCapability } from "./delegated-campaign-coordinator.js";
import { CampaignRunLease } from "./campaign-run-lease.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWNER = "g4:vm2-only:synthetic-probe:";
const TASK_ID = "inspect";
const WORKSPACE_ID = "g4-probe";
const LEASE_MS = 2_000;
const HEARTBEAT_MS = 300;
const MAX_RSS_BYTES = 256 * 1024 * 1024;
const WAIT_MS = 10_000;

/**
 * A deliberately synthetic probe for the real persisted coordinator and OS
 * process-death lease. It never connects to a repository, the enrolled G4
 * campaign, or the trusted service. A PASS is NOT cross-VM exclusivity or
 * proof of an external operation's effects.
 */
export interface G4ProbeResult {
  campaignId: string;
  operationId: string;
  stop: "all_completed";
  revision: number;
  redispatches: 0;
  memoryRssBytes: number;
  sigterm: "observed";
  outcomeUnknown: "observed";
  crossVm: "not_tested_local_lease_only";
}
export interface G4ProbeOptions {
  /** Test-only seam; the production CLI always supplies the fixed state root. */
  stateParent: string;
  campaignId: string;
  workerScript: string;
  workerExecArgv?: string[];
}
type WorkerReady = {
  kind: "in_flight";
  operationId: string;
  memoryRssBytes: number;
};
function assertIdentity(id: string): void {
  if (!UUID.test(id)) throw new Error("G4_PROBE_INVALID_ID");
}
function fixtureRoot(parent: string, id: string): string {
  assertIdentity(id);
  if (!path.isAbsolute(parent)) throw new Error("G4_PROBE_INVALID_STATE_ROOT");
  return path.join(parent, "g4-inflight-" + id);
}
function lease(): CampaignRunLease {
  return new CampaignRunLease({ leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS });
}
function task(id: string): CampaignStep {
  return {
    id: TASK_ID,
    action: "inspect",
    dependsOn: [],
    targetResource: "synthetic:g4:" + id,
    expectedState: "synthetic:read-only",
    argumentsDigest: createHash("sha256").update("g4-native-probe-v1:" + id).digest("hex"),
  };
}
async function privateDirectory(dir: string): Promise<void> {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) {
    throw new Error("G4_PROBE_UNTRUSTED_STATE");
  }
}
function ledger(root: string, id: string): DelegatedCampaignLedger {
  return new DelegatedCampaignLedger(root, OWNER + id, lease());
}
function bindings(id: string, mode: "unknown" | "verified", callbacks: { redispatches: number }):
  ReadonlyMap<string, TypedCampaignCapability> {
  const definition = task(id);
  const capability: TypedCampaignCapability = {
    action: definition.action,
    targetResource: definition.targetResource,
    expectedState: definition.expectedState,
    argumentsDigest: definition.argumentsDigest,
    execute: async () => {
      callbacks.redispatches++;
      throw new Error("G4_PROBE_UNEXPECTED_REDISPATCH");
    },
    reconcile: async req => mode === "unknown"
      ? {
        operationId: req.operationId,
        targetResource: req.targetResource,
        expectedState: req.expectedState,
        argumentsDigest: req.argumentsDigest,
        state: "outcome_unknown",
      }
      : {
        operationId: req.operationId,
        targetResource: req.targetResource,
        expectedState: req.expectedState,
        argumentsDigest: req.argumentsDigest,
        state: "succeeded",
        proof: { kind: "verified", reference: "synthetic:sigterm:" + req.operationId },
      },
    verify: async (req, receipt) => receipt.state === "succeeded" &&
      receipt.proof.reference === "synthetic:sigterm:" + req.operationId,
  };
  return new Map([[TASK_ID, capability]]);
}
async function readyMessage(child: ChildProcess): Promise<WorkerReady> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("G4_PROBE_CHILD_READY_TIMEOUT")), WAIT_MS);
    function done(error?: Error, value?: WorkerReady): void {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", exited);
      child.off("error", failed);
      if (error) reject(error);
      else resolve(value!);
    }
    function receive(data: unknown): void {
      if (!data || typeof data !== "object") return;
      const msg = data as Partial<WorkerReady>;
      if (msg.kind !== "in_flight") return;
      if (typeof msg.operationId !== "string" || !UUID.test(msg.operationId) ||
        typeof msg.memoryRssBytes !== "number" ||
        msg.memoryRssBytes < 1 || msg.memoryRssBytes > MAX_RSS_BYTES) {
        done(new Error("G4_PROBE_CHILD_INVALID_ATTESTATION"));
        return;
      }
      done(undefined, msg as WorkerReady);
    }
    function exited(): void { done(new Error("G4_PROBE_CHILD_EXITED_BEFORE_CLAIM")); }
    function failed(): void { done(new Error("G4_PROBE_CHILD_START_FAILED")); }
    child.on("message", receive);
    child.once("exit", exited);
    child.once("error", failed);
  });
}
async function stopChild(child: ChildProcess): Promise<"SIGTERM"> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    throw new Error("G4_PROBE_CHILD_NOT_RUNNING");
  }
  const result = new Promise<string | null>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("G4_PROBE_CHILD_EXIT_TIMEOUT")), WAIT_MS);
    child.once("exit", (_code, signal) => {
      clearTimeout(timeout);
      resolve(signal);
    });
  });
  if (!child.kill("SIGTERM")) throw new Error("G4_PROBE_SIGTERM_FAILED");
  if (await result !== "SIGTERM") throw new Error("G4_PROBE_UNEXPECTED_EXIT");
  return "SIGTERM";
}

/** Called only by the internal child process, after a parent has created its
 * private campaign state. Does not create any record or workspace. */
export async function runG4ProbeWorker(stateParent: string, id: string): Promise<never> {
  if (!process.send) throw new Error("G4_PROBE_WORKER_REQUIRES_IPC");
  const root = fixtureRoot(stateParent, id);
  await privateDirectory(stateParent);
  await privateDirectory(root);
  const record = await ledger(root, id).get(WORKSPACE_ID, id);
  if (!record || record.revision !== 0 || record.tasks.length !== 1 ||
      record.tasks[0]?.state !== "pending") throw new Error("G4_PROBE_WORKER_UNTRUSTED_PLAN");
  const definition = task(id);
  if (record.tasks[0].targetResource !== definition.targetResource ||
      record.tasks[0].argumentsDigest !== definition.argumentsDigest) {
    throw new Error("G4_PROBE_WORKER_BINDING_MISMATCH");
  }
  // This memory belongs solely to the synthetic child, not a production service.
  const allocation = Buffer.alloc(32 * 1024 * 1024, 1);
  const capability: TypedCampaignCapability = {
    action: definition.action,
    targetResource: definition.targetResource,
    expectedState: definition.expectedState,
    argumentsDigest: definition.argumentsDigest,
    execute: async request => {
      if (allocation[0] !== 1) throw new Error("G4_PROBE_BUFFER_INVALID");
      process.send!({
        kind: "in_flight", operationId: request.operationId,
        memoryRssBytes: process.memoryUsage().rss,
      } satisfies WorkerReady);
      await new Promise<never>(() => undefined);
      throw new Error("G4_PROBE_UNREACHABLE");
    },
    reconcile: async () => { throw new Error("G4_PROBE_UNEXPECTED_WORKER_RECOVERY"); },
    verify: async () => false,
  };
  await new DelegatedCampaignCoordinator(ledger(root, id),
    new Map([[TASK_ID, capability]])).run(WORKSPACE_ID, id, 2);
  throw new Error("G4_PROBE_WORKER_RETURNED");
}

/** One-shot. An existing state directory always fails closed; never
 * re-enrolls or replays a partially executed probe. Inspect it instead. */
export async function runG4SafetyProbe(options: G4ProbeOptions): Promise<G4ProbeResult> {
  const { stateParent, campaignId: id, workerScript } = options;
  const root = fixtureRoot(stateParent, id);
  await privateDirectory(stateParent);
  await mkdir(root, { mode: 0o700 }); // EEXIST is intentional and never cleared.
  await privateDirectory(root);
  const record = ledger(root, id);
  const original = await record.create({
    campaignId: id, workspaceId: WORKSPACE_ID,
    objective: "Bounded synthetic read-only G4 interruption and reconciliation probe",
    authorizedActions: ["inspect"], tasks: [task(id)],
  });
  if (original.revision !== 0) throw new Error("G4_PROBE_ALREADY_STARTED");
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [
      ...(options.workerExecArgv ?? []),
      workerScript, "worker", id, stateParent,
    ], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    const ready = await readyMessage(child);
    const active = await record.get(WORKSPACE_ID, id);
    if (!active || active.revision !== 1 || active.tasks[0]?.state !== "in_flight" ||
        active.tasks[0].operationId !== ready.operationId) {
      throw new Error("G4_PROBE_INFLIGHT_NOT_PERSISTED");
    }
    const counters = { redispatches: 0 };
    const unknown = () => new DelegatedCampaignCoordinator(record, bindings(id, "unknown", counters));
    let denied = false;
    try { await unknown().run(WORKSPACE_ID, id, 2); }
    catch (err) { denied = (err as NodeJS.ErrnoException).code === "EEXIST"; }
    if (!denied) throw new Error("G4_PROBE_LIVE_OWNER_NOT_EXCLUSIVE");
    await stopChild(child);
    const afterKill = await record.get(WORKSPACE_ID, id);
    if (!afterKill || afterKill.revision !== 1 || afterKill.tasks[0]?.state !== "in_flight" ||
      afterKill.tasks[0].operationId !== ready.operationId) {
      throw new Error("G4_PROBE_SIGTERM_LOST_IDENTITY");
    }
    await delay(LEASE_MS + 250);
    const uncertain = await unknown().run(WORKSPACE_ID, id, 2);
    const afterUnknown = await record.get(WORKSPACE_ID, id);
    if (uncertain.executed !== 0 || uncertain.reconciled !== 1 ||
      !afterUnknown || afterUnknown.revision !== 2 ||
      afterUnknown.tasks[0]?.state !== "outcome_unknown" ||
      afterUnknown.tasks[0].operationId !== ready.operationId) {
      throw new Error("G4_PROBE_UNKNOWN_MISMATCH");
    }
    const verified = () => new DelegatedCampaignCoordinator(record, bindings(id, "verified", counters));
    const result = await verified().run(WORKSPACE_ID, id, 3);
    const again = await verified().run(WORKSPACE_ID, id, 2);
    const final = await record.get(WORKSPACE_ID, id);
    if (result.stop !== "all_completed" || result.executed !== 0 ||
      result.reconciled !== 1 || again.executed !== 0 ||
      !final || final.revision !== 3 || final.tasks[0]?.state !== "completed" ||
      final.tasks[0].operationId !== ready.operationId || counters.redispatches !== 0) {
      throw new Error("G4_PROBE_RECONCILIATION_MISMATCH");
    }
    return {
      campaignId: id, operationId: ready.operationId, stop: "all_completed",
      revision: final.revision, redispatches: 0,
      memoryRssBytes: ready.memoryRssBytes,
      sigterm: "observed", outcomeUnknown: "observed",
      crossVm: "not_tested_local_lease_only",
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

export async function inspectG4Probe(stateParent: string, id: string):
  Promise<{ campaignId: string; state: string; revision: number; operationId?: string }> {
  const root = fixtureRoot(stateParent, id);
  await privateDirectory(stateParent);
  try { await privateDirectory(root); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { campaignId: id, state: "not_started", revision: 0 };
    }
    throw err;
  }
  const record = await ledger(root, id).get(WORKSPACE_ID, id);
  if (!record) return { campaignId: id, state: "no_ledger", revision: 0 };
  const task = record.tasks[0];
  return { campaignId: id, state: task?.state ?? "invalid", revision: record.revision,
    ...(task?.operationId ? { operationId: task.operationId } : {}) };
}
