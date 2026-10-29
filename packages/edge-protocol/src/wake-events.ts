// Something the agent may be waiting for ended on a runtime that has no chat
// to wake: a background task or a GitHub checks watch on the execution node.
// The node tells the Edge, and the Edge tells the user's companions, which
// wake the ChatGPT conversation. Only ids, names and states travel.

export const WAKE_EVENTS_FEATURE = "wakeEventsV1" as const;
/** A companion that announces this capability takes wake events from the Edge. */
export const WAKE_EVENTS_CAPABILITY = "wake-events-v1" as const;

export type WakeEvent =
  | { kind: "task"; taskId: string; workspaceId: string; state: "succeeded" | "failed"; exitCode?: number }
  | {
    kind: "checks";
    watchId: string;
    workspaceId: string;
    repository: string;
    commitSha: string;
    state: "passed" | "failed" | "timed_out" | "error";
  };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[0-9a-f]{40}$/u;

export function parseWakeEvent(value: unknown): WakeEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.workspaceId !== "string" || !ID.test(event.workspaceId)) return null;
  if (event.kind === "task") {
    if (typeof event.taskId !== "string" || !ID.test(event.taskId)) return null;
    if (event.state !== "succeeded" && event.state !== "failed") return null;
    if (event.exitCode !== undefined && (typeof event.exitCode !== "number" || !Number.isInteger(event.exitCode))) return null;
    return {
      kind: "task",
      taskId: event.taskId,
      workspaceId: event.workspaceId,
      state: event.state,
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode as number }),
    };
  }
  if (event.kind === "checks") {
    if (typeof event.watchId !== "string" || !ID.test(event.watchId)) return null;
    if (typeof event.repository !== "string" || !REPOSITORY.test(event.repository)) return null;
    if (typeof event.commitSha !== "string" || !SHA.test(event.commitSha)) return null;
    if (event.state !== "passed" && event.state !== "failed" && event.state !== "timed_out" && event.state !== "error") return null;
    return {
      kind: "checks",
      watchId: event.watchId,
      workspaceId: event.workspaceId,
      repository: event.repository,
      commitSha: event.commitSha,
      state: event.state,
    };
  }
  return null;
}
