// The checklist card ChatGPT shows with browser_progress: the plan of the
// work in this conversation, step by step, done, in progress and to do. The
// agent opens it once; browser_progress_update changes the same plan and the
// card, which reads it again every few seconds through browser_progress_read,
// follows. Nothing runs, so the Edge answers these calls itself, even with no
// companion connected, and keeps each user's recent plans. A long operation on
// a runtime that was handed the planId moves the same plan (applyUpdate).

import { PROGRESS_STEP_STATES, type ProgressStepState, type ProgressUpdate } from "@mcp-access-stack/edge-protocol";
import { CARD_BASE_CSS, CARD_PIN_BUTTON, CARD_THEME_SCRIPT } from "./card-style.js";
import type { EdgeUiResource } from "./user-messages-card.js";

export const PROGRESS_CARD_URI = "ui://mcp-v3/progress-v1.html";
export const PROGRESS_TOOLS = ["browser_progress", "browser_progress_update", "browser_progress_read"] as const;

const STATES = new Set<string>(PROGRESS_STEP_STATES);
const PLAN_ID = /^plan_[0-9a-f-]{36}$/u;
const MAX_PLANS = 20;
const OWNER_PREFIX = "progress-plan-owner:";

export const PROGRESS_CARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CARD_BASE_CSS}
  li { padding: 4px 0; }
  li.done { color: var(--muted); }
  li.doing { font-weight: 600; }
  li.skipped { color: var(--muted); text-decoration: line-through; }
  li.failed { font-weight: 600; }
  svg { flex: none; width: 18px; height: 18px; margin-top: 1px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1.6s linear infinite; transform-origin: 50% 50%; }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
</head>
<body>
<div class="head"><h1 id="title">Etapas</h1><div class="chips"><span class="chip" id="count" hidden></span>${CARD_PIN_BUTTON}</div></div>
<ul id="steps"></ul>
<script>
(function () {
  ${CARD_THEME_SCRIPT}
  var ICONS = {
    done: '<svg viewBox="0 0 20 20" aria-label="concluída"><circle cx="10" cy="10" r="9" fill="var(--fg)"/><path d="M6 10.4l2.6 2.6L14.2 7.4" fill="none" stroke="var(--bg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    doing: '<svg viewBox="0 0 20 20" aria-label="em andamento"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)" stroke-width="2"/><path class="spin" d="M10 2a8 8 0 0 1 8 8" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>',
    todo: '<svg viewBox="0 0 20 20" aria-label="a fazer"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="2.6 2.6"/></svg>',
    failed: '<svg viewBox="0 0 20 20" aria-label="falhou"><circle cx="10" cy="10" r="9" fill="#d93025"/><path d="M7 7l6 6M13 7l-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
    skipped: '<svg viewBox="0 0 20 20" aria-label="pulada"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--muted)" stroke-width="1.6"/><path d="M6 10h8" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/></svg>'
  };
  var latest = null;
  function data() {
    if (latest) return latest;
    var bridge = window.openai || {};
    var out = bridge.toolOutput;
    if (out && Array.isArray(out.steps)) return out;
    return bridge.toolInput || {};
  }
  // The agent changes the plan with browser_progress_update; the card reads it again.
  function refresh() {
    var bridge = window.openai;
    var planId = bridge && bridge.toolOutput && bridge.toolOutput.planId;
    if (!planId || typeof bridge.callTool !== "function" || document.hidden) return;
    Promise.resolve(bridge.callTool("browser_progress_read", { planId: planId })).then(function (result) {
      var value = result && (result.structuredContent || result);
      if (value && !result.isError && Array.isArray(value.steps)) { latest = value; render(); }
    }).catch(function () {});
  }
  function render() {
    applyTheme();
    var value = data();
    document.getElementById("title").textContent = typeof value.title === "string" && value.title.trim() ? value.title : "Etapas";
    var list = document.getElementById("steps");
    list.textContent = "";
    var steps = Array.isArray(value.steps) ? value.steps : [];
    var done = 0;
    steps.forEach(function (step) {
      if (!step || typeof step.text !== "string") return;
      var state = ICONS[step.state] ? step.state : "todo";
      if (state === "done" || state === "skipped") done += 1;
      var li = document.createElement("li");
      li.className = state;
      li.innerHTML = ICONS[state];
      var span = document.createElement("span");
      span.className = "grow";
      span.textContent = step.text;
      li.appendChild(span);
      list.appendChild(li);
    });
    var count = document.getElementById("count");
    count.hidden = steps.length === 0;
    count.textContent = done + "/" + steps.length;
  }
  window.addEventListener("openai:set_globals", render);
  document.addEventListener("visibilitychange", refresh);
  setInterval(refresh, 4000);
  render();
})();
</script>
</body>
</html>
`;

export const PROGRESS_CARD_RESOURCE: EdgeUiResource = {
  uri: PROGRESS_CARD_URI,
  name: "Etapas",
  description: "Shows the plan of the agent's work, step by step: done, in progress and to do.",
  mimeType: "text/html;profile=mcp-app",
  text: PROGRESS_CARD_HTML,
  _meta: {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
    "openai/widgetPrefersBorder": true,
    "openai/widgetDescription": "The plan of this conversation's work; it follows the agent's and the runtimes' updates by itself.",
  },
};

export interface ProgressPlan {
  planId: string;
  title: string;
  steps: Array<{ text: string; state: ProgressStepState }>;
  updatedAt: string;
}

export interface ProgressStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class ProgressPlans {
  constructor(
    private readonly storage: ProgressStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => `plan_${crypto.randomUUID()}`,
  ) {}

  /** Answers the three progress tools, or null for any other request. */
  async handle(body: unknown, userId: string | undefined): Promise<Response | null> {
    if (!isRecord(body) || body.jsonrpc !== "2.0" || body.method !== "tools/call") return null;
    if (!isRecord(body.params) || !(PROGRESS_TOOLS as readonly unknown[]).includes(body.params.name)) return null;
    const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
    const name = body.params.name as (typeof PROGRESS_TOOLS)[number];
    // Every browser tool also takes deviceId and runtimeId; nothing here runs on a device.
    const { deviceId: _deviceId, runtimeId: _runtimeId, ...args } = isRecord(body.params.arguments) ? body.params.arguments : {};
    if (!userId) return toolError(id, "IDENTITY_REQUIRED", "Reconnect MCP V3 to show the plan.");
    const key = `progress-plans:${userId}`;
    const plans = (await this.storage.get<ProgressPlan[]>(key)) ?? [];

    if (name === "browser_progress_read") {
      const plan = typeof args.planId === "string" ? plans.find((entry) => entry.planId === args.planId) : undefined;
      return plan ? toolResult(id, `Plan ${plan.planId}.`, plan) : toolError(id, "NOT_FOUND", "This plan is no longer kept.");
    }

    const allowed = name === "browser_progress" ? ["title", "steps"] : ["planId", "title", "steps"];
    const input = readPlanInput(args, allowed);
    if (!input) return invalid(id, name);
    let plan: ProgressPlan;
    if (name === "browser_progress") {
      plan = { planId: this.newId(), title: input.title!, steps: input.steps, updatedAt: this.now().toISOString() };
      const kept = [...plans, plan].slice(-MAX_PLANS);
      await this.storage.put(key, kept);
      for (const dropped of plans.filter((entry) => !kept.includes(entry))) {
        await this.storage.delete(`${OWNER_PREFIX}${dropped.planId}`);
      }
      // A runtime given this planId finds whose plan it moves.
      await this.storage.put(`${OWNER_PREFIX}${plan.planId}`, userId);
    } else {
      const current = plans.find((entry) => entry.planId === args.planId);
      if (!current) return toolError(id, "NOT_FOUND", "No plan with this planId; open one with browser_progress.");
      plan = { ...current, ...(input.title === undefined ? {} : { title: input.title }), steps: input.steps, updatedAt: this.now().toISOString() };
      await this.storage.put(key, plans.map((entry) => (entry.planId === plan.planId ? plan : entry)));
    }
    const done = plan.steps.filter((step) => step.state === "done" || step.state === "skipped").length;
    const text = name === "browser_progress"
      ? `Plan shown to the user (planId ${plan.planId}, ${done}/${plan.steps.length} done). Update it with browser_progress_update and this planId; the same card follows.`
      : `Plan updated: ${done}/${plan.steps.length} done.`;
    return toolResult(id, text, plan);
  }

  /**
   * A runtime's step of a long operation. It replaces the steps of a plan the
   * agent opened, and nothing else: an unknown or expired planId changes
   * nothing. ownerUserId, when known (a companion), must own the plan.
   */
  async applyUpdate(update: ProgressUpdate, ownerUserId?: string): Promise<boolean> {
    const userId = await this.storage.get<string>(`${OWNER_PREFIX}${update.planId}`);
    if (!userId || (ownerUserId !== undefined && ownerUserId !== userId)) return false;
    const key = `progress-plans:${userId}`;
    const plans = (await this.storage.get<ProgressPlan[]>(key)) ?? [];
    const current = plans.find((entry) => entry.planId === update.planId);
    if (!current) return false;
    const plan: ProgressPlan = {
      ...current,
      ...(update.title === undefined ? {} : { title: update.title }),
      steps: update.steps,
      updatedAt: this.now().toISOString(),
    };
    await this.storage.put(key, plans.map((entry) => (entry.planId === plan.planId ? plan : entry)));
    return true;
  }
}

function readPlanInput(value: Record<string, unknown>, allowed: readonly string[]): { title?: string; steps: ProgressPlan["steps"] } | null {
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (allowed.includes("planId") && (typeof value.planId !== "string" || !PLAN_ID.test(value.planId))) return null;
  let title: string | undefined;
  if (value.title !== undefined || !allowed.includes("planId")) {
    title = typeof value.title === "string" ? value.title.trim() : "";
    if (title.length < 1 || title.length > 120) return null;
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 20) return null;
  const steps: ProgressPlan["steps"] = [];
  for (const step of value.steps) {
    if (!isRecord(step) || Object.keys(step).some((key) => key !== "text" && key !== "state")) return null;
    const text = typeof step.text === "string" ? step.text.trim() : "";
    if (text.length < 1 || text.length > 200 || typeof step.state !== "string" || !STATES.has(step.state)) return null;
    steps.push({ text, state: step.state as ProgressPlan["steps"][number]["state"] });
  }
  return { ...(title === undefined ? {} : { title }), steps };
}

function invalid(id: string | number | null, name: string): Response {
  return toolError(id, "INVALID_ARGUMENT", `Input validation error: Invalid arguments for tool ${name}.`);
}

function toolResult(id: string | number | null, text: string, structuredContent: ProgressPlan): Response {
  return rpc(id, { content: [{ type: "text", text }], structuredContent });
}

function toolError(id: string | number | null, code: string, message: string): Response {
  return rpc(id, { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] });
}

function rpc(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
