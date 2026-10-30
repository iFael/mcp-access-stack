// A long operation on a runtime (the execution node or a companion) moves the
// plan card the agent opened with browser_progress. The agent hands the
// operation the card's planId; the runtime sends the whole plan again after
// each step, and the Edge stores it in place of the plan, so the card follows
// without the agent. Only the plan's own text travels: each step may add why
// it is waiting (detail) and a GitHub page that shows it (link).

export const PROGRESS_FEATURE = "progressV1" as const;

export const PROGRESS_STEP_STATES = ["done", "doing", "todo", "failed", "skipped"] as const;
export type ProgressStepState = (typeof PROGRESS_STEP_STATES)[number];

export type ProgressStep = { text: string; state: ProgressStepState; detail?: string; link?: string };

export type ProgressUpdate = {
  planId: string;
  title?: string;
  steps: ProgressStep[];
};

export const PROGRESS_DETAIL_MAX = 160;
const LINK = /^https:\/\/github\.com\/[^\s"<>]{1,280}$/u;

/** One step as the plan keeps it, or null; shared by the Edge and the runtimes. */
export function parseProgressStep(value: unknown): ProgressStep | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["text", "state", "detail", "link"].includes(key))) return null;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (text.length < 1 || text.length > 200) return null;
  if (!(PROGRESS_STEP_STATES as readonly unknown[]).includes(value.state)) return null;
  const step: ProgressStep = { text, state: value.state as ProgressStepState };
  if (value.detail !== undefined) {
    const detail = typeof value.detail === "string" ? value.detail.trim() : "";
    if (detail.length < 1 || detail.length > PROGRESS_DETAIL_MAX) return null;
    step.detail = detail;
  }
  if (value.link !== undefined) {
    if (typeof value.link !== "string" || !LINK.test(value.link)) return null;
    step.link = value.link;
  }
  return step;
}

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
  for (const entry of value.steps) {
    const step = parseProgressStep(entry);
    if (!step) return null;
    steps.push(step);
  }
  return { planId: value.planId, ...(title === undefined ? {} : { title }), steps };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
