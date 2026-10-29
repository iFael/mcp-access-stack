import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  prepareOnce,
  promoteOnce,
  releaseIdOf,
  StopUpdate,
  type ReleaseInstallData,
  type ReleaseInstallPort,
} from "./release-install.js";

// The Windows half of an mcp_update, on the companion. The execution node
// asks, through the Edge, for a companion release tag to be installed in this
// device's MCP Access Stack workspace; the companion prepares and promotes it,
// each once, and answers every request with where it stands. The record is
// written before every effect, so the companion its own promote starts picks
// up the wait and answers the next request with the outcome.

export type CompanionUpdateRequest = { updateId: string; tag: string; confirmationId?: string };

export type CompanionUpdateStatus = {
  updateId: string;
  phase: "prepare" | "promote";
  state: "running" | "succeeded" | "failed" | "needs_confirmation";
  error?: { code: string; message: string };
  confirmation?: { confirmationId: string; reasons: string[]; expiresAt: string };
};

export interface CompanionUpdateRecord extends CompanionUpdateStatus {
  version: 1;
  tag: string;
  createdAt: string;
  updatedAt: string;
  /** The approved confirmation, kept until the phase that asked for it is done. */
  approvedConfirmationId?: string;
  data: ReleaseInstallData;
}

export interface CompanionUpdateRunnerOptions {
  stateDirectory: string;
  /** The release operations of this device's MCP Access Stack workspace, or null when it has none. */
  port: () => ReleaseInstallPort | null;
  /** Sends the status to the Edge, for the execution node. */
  report: (status: CompanionUpdateStatus) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  stepTimeoutMs?: number;
}

const UPDATE_ID = /^upd_[0-9a-f-]{36}$/u;
const COMPANION_TAG = /^v\d+\.\d+\.\d+-companion\.[1-9]\d{0,19}$/u;

export class CompanionUpdateRunner {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly stepTimeoutMs: number;
  private readonly driving = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CompanionUpdateRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.pollMs = options.pollMs ?? 15_000;
    this.stepTimeoutMs = options.stepTimeoutMs ?? 45 * 60_000;
  }

  /** Continues an install the previous companion left running, usually across its own promote. */
  async recover(): Promise<void> {
    for (const record of await this.list()) {
      if (record.state === "running") this.drive(record.updateId);
    }
  }

  /** Starts, resumes or only reports the install a request names; one request at a time. */
  handle(request: CompanionUpdateRequest): Promise<void> {
    const next = this.queue.then(() => this.accept(request));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async read(updateId: string): Promise<CompanionUpdateRecord | null> {
    if (!UPDATE_ID.test(updateId)) return null;
    try {
      return JSON.parse(await readFile(this.file(updateId), "utf8")) as CompanionUpdateRecord;
    } catch {
      return null;
    }
  }

  /** Resolves when the install stops driving; for tests and shutdown. */
  async settled(updateId: string): Promise<CompanionUpdateRecord | null> {
    while (this.driving.has(updateId)) await new Promise((resolve) => setTimeout(resolve, 1));
    return this.read(updateId);
  }

  private async accept(request: CompanionUpdateRequest): Promise<void> {
    if (!UPDATE_ID.test(request.updateId) || !COMPANION_TAG.test(request.tag)) return;
    let record = await this.read(request.updateId);
    if (record === null) {
      const open = (await this.list()).find((other) => other.state === "running" || other.state === "needs_confirmation");
      if (open) {
        this.options.report({ updateId: request.updateId, phase: "prepare", state: "failed",
          error: { code: "UPDATE_IN_PROGRESS", message: `This companion is installing ${open.tag} for ${open.updateId}.` } });
        return;
      }
      const at = this.now().toISOString();
      record = { version: 1, updateId: request.updateId, tag: request.tag, phase: "prepare", state: "running",
        createdAt: at, updatedAt: at, data: {} };
      await this.save(record);
    } else if (record.tag !== request.tag) {
      return;
    } else if (record.state === "needs_confirmation" && request.confirmationId !== undefined &&
        request.confirmationId === record.confirmation?.confirmationId) {
      const { confirmation: _confirmation, ...waiting } = record;
      record = { ...waiting, state: "running", approvedConfirmationId: request.confirmationId };
      await this.save(record);
    }
    if (record.state === "running") this.drive(record.updateId);
    this.options.report(statusOf(record));
  }

  private drive(updateId: string): void {
    if (this.driving.has(updateId)) return;
    this.driving.add(updateId);
    void this.run(updateId).finally(() => this.driving.delete(updateId));
  }

  private async run(updateId: string): Promise<void> {
    let record = (await this.read(updateId))!;
    try {
      const port = this.options.port();
      if (port === null) throw new StopUpdate("WORKSPACE_MISSING", "This companion has no MCP Access Stack workspace.");
      const releaseId = releaseIdOf(record.tag);
      while (record.state === "running") {
        const context = {
          port,
          save: (data: ReleaseInstallData) => this.save({ ...record, data }),
          until: (code: string, what: string, done: () => Promise<boolean>, since?: string) => this.until(code, what, done, since),
          now: this.now,
          confirmationId: record.approvedConfirmationId,
        };
        const { approvedConfirmationId: _approved, ...current } = record;
        if (record.phase === "prepare") {
          let data = record.data;
          if (data.activeBefore === undefined && !data.prepareRequested) {
            const state = await port.releaseState();
            if (state.active === releaseId) {
              record = { ...current, state: "succeeded" };
              await this.save(record);
              break;
            }
            if (state.candidate !== null) throw new StopUpdate("CANDIDATE_PENDING", `This companion already has candidate ${state.candidate}.`);
            data = { ...data, ...(state.active === null ? {} : { activeBefore: state.active }) };
          }
          record = { ...current, phase: "promote", data: await prepareOnce(context, record.tag, data) };
        } else {
          record = { ...current, state: "succeeded", data: await promoteOnce(context, releaseId, record.data) };
        }
        await this.save(record);
        this.options.report(statusOf(record));
      }
    } catch (error) {
      const stop = error instanceof StopUpdate ? error : new StopUpdate("UPDATE_STEP_ERROR", error instanceof Error ? error.message : String(error));
      // The phase may have saved what it requested before it stopped.
      const { approvedConfirmationId: _approved, ...latest } = (await this.read(updateId)) ?? record;
      record = {
        ...latest,
        state: stop.confirmation ? "needs_confirmation" : "failed",
        ...(stop.confirmation ? { confirmation: stop.confirmation } : { error: { code: stop.code, message: stop.message.slice(0, 500) } }),
      };
      await this.save(record);
    }
    this.options.report(statusOf(record));
  }

  private async until(code: string, what: string, done: () => Promise<boolean>, since?: string): Promise<void> {
    const deadline = (since === undefined ? this.now().getTime() : Date.parse(since)) + this.stepTimeoutMs;
    for (;;) {
      if (await done()) return;
      if (this.now().getTime() >= deadline) throw new StopUpdate(code, `Gave up waiting for ${what}.`);
      await this.sleep(this.pollMs);
    }
  }

  private file(updateId: string): string {
    return path.join(this.options.stateDirectory, `${updateId}.json`);
  }

  private async save(record: CompanionUpdateRecord): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true });
    const target = this.file(record.updateId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...record, updatedAt: this.now().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  private async list(): Promise<CompanionUpdateRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.options.stateDirectory);
    } catch {
      return [];
    }
    const records: CompanionUpdateRecord[] = [];
    for (const name of names.filter((entry) => /^upd_[0-9a-f-]{36}\.json$/u.test(entry))) {
      const record = await this.read(name.slice(0, -".json".length));
      if (record) records.push(record);
    }
    return records;
  }
}

function statusOf(record: CompanionUpdateRecord): CompanionUpdateStatus {
  return {
    updateId: record.updateId,
    phase: record.phase,
    state: record.state,
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.confirmation === undefined ? {} : { confirmation: record.confirmation }),
  };
}
