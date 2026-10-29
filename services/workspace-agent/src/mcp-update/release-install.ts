// prepare_release and promote_release of one release, each requested once,
// for the execution node and for the Windows companion alike. What was
// requested is saved before the call, so a process that dies in between, or
// that the promote itself replaces, never asks again: its successor only
// waits for the outcome.

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Replaces an update's record in one step. Each save has its own temporary
 * file, and on Windows the rename is retried while a concurrent read of the
 * record still holds it open.
 */
export async function saveRecord(target: string, text: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export class StopUpdate extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly confirmation?: { confirmationId: string; reasons: string[]; expiresAt: string },
  ) {
    super(message);
  }
}

export type ReleaseConfirmation = {
  status: "confirmation_required";
  confirmationId: string;
  reasons: string[];
  expiresAt: string;
};

export interface ReleaseInstallPort {
  releaseState(): Promise<{ active: string | null; candidate: string | null }>;
  prepare(tag: string, confirmationId?: string): Promise<ReleaseConfirmation | { status: "started"; taskId: string }>;
  task(taskId: string): Promise<"running" | "succeeded" | "failed">;
  promote(releaseId: string, confirmationId?: string): Promise<ReleaseConfirmation | { status: "handover_started" }>;
}

export interface ReleaseInstallData {
  activeBefore?: string;
  /** Set before the call: a crash in between leaves an outcome nobody may guess. */
  prepareRequested?: boolean;
  prepareTaskId?: string;
  promoteRequested?: boolean;
  promoteStartedAt?: string;
}

export interface ReleaseInstallContext {
  port: ReleaseInstallPort;
  /** Persists the data before the effect it announces. */
  save(data: ReleaseInstallData): Promise<void>;
  until(code: string, what: string, done: () => Promise<boolean>, since?: string): Promise<void>;
  now(): Date;
  /** The confirmation the user approved for this step, if it asked for one. */
  confirmationId?: string | undefined;
}

/** v1.1.0-beta.103-connector.1 → 1.1.0-beta.103-connector.1 */
export function releaseIdOf(tag: string): string {
  return tag.slice(1);
}

export async function prepareOnce(context: ReleaseInstallContext, tag: string, data: ReleaseInstallData): Promise<ReleaseInstallData> {
  const { port, confirmationId } = context;
  let taskId = data.prepareTaskId;
  if (taskId === undefined) {
    if (data.prepareRequested && confirmationId === undefined) {
      throw new StopUpdate("PREPARE_OUTCOME_UNKNOWN", "prepare_release was requested but its answer was lost; read get_release_state, never prepare again.");
    }
    await context.save({ ...data, prepareRequested: true });
    const prepared = await port.prepare(tag, confirmationId);
    if (prepared.status === "confirmation_required") {
      throw new StopUpdate("CONFIRMATION_REQUIRED", "prepare_release asks for confirmation.", {
        confirmationId: prepared.confirmationId, reasons: prepared.reasons, expiresAt: prepared.expiresAt,
      });
    }
    taskId = prepared.taskId;
    await context.save({ ...data, prepareRequested: true, prepareTaskId: taskId });
  }
  await context.until("PREPARE_TIMEOUT", "prepare_release", async () => {
    const state = await port.task(taskId!);
    if (state === "failed") throw new StopUpdate("PREPARE_FAILED", `The prepare_release task ${taskId} failed.`);
    return state === "succeeded";
  });
  const state = await port.releaseState();
  if (state.candidate !== releaseIdOf(tag)) throw new StopUpdate("CANDIDATE_MISSING", `prepare_release ended without candidate ${releaseIdOf(tag)}.`);
  return { ...data, prepareRequested: true, prepareTaskId: taskId };
}

/** Promotes once and waits for the release to be active; usually across the replacement of this process. */
export async function promoteOnce(context: ReleaseInstallContext, releaseId: string, data: ReleaseInstallData): Promise<ReleaseInstallData> {
  const { port, confirmationId } = context;
  let promoted = data;
  if (!data.promoteRequested || confirmationId !== undefined) {
    promoted = { ...data, promoteRequested: true, promoteStartedAt: context.now().toISOString() };
    await context.save(promoted);
    const result = await port.promote(releaseId, confirmationId);
    if (result.status === "confirmation_required") {
      throw new StopUpdate("CONFIRMATION_REQUIRED", "promote_release asks for confirmation.", {
        confirmationId: result.confirmationId, reasons: result.reasons, expiresAt: result.expiresAt,
      });
    }
  }
  await context.until("PROMOTE_TIMEOUT", "the promote", async () => {
    const state = await port.releaseState();
    if (state.active === releaseId) return true;
    if (state.active === data.activeBefore && state.candidate === null) {
      throw new StopUpdate("ROLLED_BACK", `The runtime went back to ${state.active}.`);
    }
    return false;
  }, promoted.promoteStartedAt);
  return promoted;
}
