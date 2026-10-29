// A long operation on a runtime (the execution node or a companion) moves the
// plan card the agent opened with browser_progress. The agent hands the
// operation the card's planId; the runtime sends the whole plan again after
// each step, and the Edge stores it in place of the plan, so the card follows
// without the agent. Only the plan's own text travels.

export const PROGRESS_FEATURE = "progressV1" as const;

export const PROGRESS_STEP_STATES = ["done", "doing", "todo", "failed", "skipped"] as const;
export type ProgressStepState = (typeof PROGRESS_STEP_STATES)[number];

export type ProgressUpdate = {
  planId: string;
  title?: string;
  steps: Array<{ text: string; state: ProgressStepState }>;
};

export const PROGRESS_PLAN_ID = /^plan_[0-9a-f-]{36}$/u;

export function parseProgressUpdate(value: unknown): ProgressUpdate | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "planId" && key !== "title" && key !== "steps")) return null;
  if (typeof value.planId !== "string" || !PROGRESS_PLAN_ID.test(value.planId)) return null;
  let title: string | undefined;
  if (value.title !== undefined) {
    title = typeof value.title === "string" ? value.title.trim() : "";
    if (title.length < 1 || title.length > 120) return null;
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 20) return null;
  const steps: ProgressUpdate["steps"] = [];
  for (const step of value.steps) {
    if (!isRecord(step) || Object.keys(step).some((key) => key !== "text" && key !== "state")) return null;
    const text = typeof step.text === "string" ? step.text.trim() : "";
    if (text.length < 1 || text.length > 200) return null;
    if (!(PROGRESS_STEP_STATES as readonly unknown[]).includes(step.state)) return null;
    steps.push({ text, state: step.state as ProgressStepState });
  }
  return { planId: value.planId, ...(title === undefined ? {} : { title }), steps };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
