import { randomUUID, randomBytes } from "node:crypto";
import { hostname as localHostname } from "node:os";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

type RunLeaseRecord = {
  version: 1;
  ownerId: string;
  hostname: string;
  pid: number;
  issuedAt: number;
  renewedAt: number;
  expiresAt: number;
};
export interface CampaignRunLeaseOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  /** Test seam. Production always uses kill(pid, 0) and fails closed on uncertainty. */
  isProcessAlive?: (pid: number) => boolean;
  hostname?: string;
  pid?: number;
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function valid(value: unknown): value is RunLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<RunLeaseRecord>;
  return r.version === 1 && typeof r.ownerId === "string" && ID.test(r.ownerId) &&
    typeof r.hostname === "string" && r.hostname.length > 0 && r.hostname.length <= 256 &&
    typeof r.pid === "number" && Number.isSafeInteger(r.pid) && r.pid > 0 &&
    typeof r.issuedAt === "number" && Number.isSafeInteger(r.issuedAt) &&
    typeof r.renewedAt === "number" && Number.isSafeInteger(r.renewedAt) &&
    typeof r.expiresAt === "number" && Number.isSafeInteger(r.expiresAt) &&
    r.issuedAt > 0 && r.issuedAt <= r.renewedAt &&
    r.renewedAt < r.expiresAt;
}
function locked(): Error {
  const error = new Error("CAMPAIGN_RUN_LOCKED: owner alive, unproven, or recovery already active") as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}

/**
 * A lease is advisory for scheduling, NOT permission to steal the lock at TTL.
 * A takeover requires the exact owner process to have exited on this host.
 * Unknown liveness, PID reuse, corrupt locks, another host, or a contender
 * already recovering => fail closed. No lock is reclaimed on TTL alone.
 */
export class CampaignRunLease {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly hostname: string;
  private readonly pid: number;

  constructor(options: CampaignRunLeaseOptions = {}) {
    this.leaseMs = options.leaseMs ?? 90_000;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1000 ||
        !Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 100 ||
        this.heartbeatMs * 2 >= this.leaseMs) {
      throw new Error("CAMPAIGN_INVALID: lease/heartbeat interval");
    }
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? processAlive;
    this.hostname = options.hostname ?? localHostname();
    this.pid = options.pid ?? process.pid;
    if (!this.hostname || !Number.isSafeInteger(this.pid) || this.pid <= 0) {
      throw new Error("CAMPAIGN_INVALID: run owner");
    }
  }

  private async readLease(file: string): Promise<RunLeaseRecord> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(file, "utf8")); }
    catch { throw locked(); }
    if (!valid(parsed)) throw locked();
    return parsed;
  }

  private async putNew(file: string, lease: RunLeaseRecord): Promise<void> {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(lease), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async renew(file: string, ownerId: string): Promise<void> {
    const prior = await this.readLease(file);
    if (prior.ownerId !== ownerId || prior.hostname !== this.hostname ||
        prior.pid !== this.pid) throw locked();
    const at = this.now();
    // A clock rollback or a lost/expired lease is not silently accepted.
    if (at < prior.renewedAt || at > prior.expiresAt) throw locked();
    const next: RunLeaseRecord = { ...prior, renewedAt: at, expiresAt: at + this.leaseMs };
    const temp = file + ".heartbeat-" + randomBytes(8).toString("hex");
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next), "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async tryRecover(file: string, replacement: RunLeaseRecord): Promise<void> {
    // Exclusive RECOVERY guard prevents two recoverers from deleting each
    // other's newly acquired lock. A crashed guard is itself fail-closed.
    const guardPath = file + ".recovery.lock";
    let guard;
    try { guard = await open(guardPath, "wx", 0o600); }
    catch { throw locked(); }
    try {
      const state = await this.readLease(file);
      if (state.hostname !== this.hostname ||
          state.expiresAt >= this.now() ||
          this.isProcessAlive(state.pid) !== false) throw locked();
      // The run owner is provably no longer executing on this host.
      // Coordinator will reconcile the persisted operation, never redispatch.
      await rm(file);
      // Reacquire BEFORE dropping recovery guard. This closes the race
      // where another recoverer could delete a just-acquired new lease.
      await this.putNew(file, replacement);
    } finally {
      await guard.close();
      await rm(guardPath);
    }
  }

  async run<T>(file: string, task: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const ownerId = randomUUID();
    const at = this.now();
    const record: RunLeaseRecord = {
      version: 1, ownerId, hostname: this.hostname, pid: this.pid,
      issuedAt: at, renewedAt: at, expiresAt: at + this.leaseMs,
    };
    try {
      await this.putNew(file, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Reclaim in an exclusive guard. Another caller may have won the lock
      // before this caller reacquires it; wx still denies the loser.
      await this.tryRecover(file, record);
    }
    let ended = false;
    let heartbeatError: unknown;
    let outstanding: Promise<void> = Promise.resolve();
    const interval = setInterval(() => {
      if (ended || heartbeatError) return;
      outstanding = outstanding.then(() => this.renew(file, ownerId)).catch(error => {
        heartbeatError = error;
      });
    }, this.heartbeatMs);
    interval.unref();
    try {
      const value = await task();
      if (heartbeatError) throw heartbeatError;
      return value;
    } finally {
      ended = true;
      clearInterval(interval);
      await outstanding;
      // Never delete a different generation of the lease.
      const owner = await this.readLease(file);
      if (owner.ownerId !== ownerId) throw locked();
      await rm(file);
    }
  }
}
