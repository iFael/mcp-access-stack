// The checklist card ChatGPT shows with browser_progress: the plan of the
// work in this conversation, step by step, done, in progress and to do. The
// agent opens it once; browser_progress_update changes the same plan and the
// card, which reads it again every few seconds through browser_progress_read,
// follows. Nothing runs, so the Edge answers these calls itself, even with no
// companion connected, and keeps each user's recent plans. A long operation on
// a runtime that was handed the planId moves the same plan (applyUpdate).
// The Edge notes when each step starts and ends, so the card shows how long
// it took or has been running. browser_progress with only a planId shows the
// card again at the end of an answer; its older copies fold into one line.

import { parseProgressStep, type ProgressStep, type ProgressUpdate } from "@mcp-access-stack/edge-protocol";
import { CARD_BASE_CSS, CARD_FIT_SCRIPT, CARD_THEME_SCRIPT } from "./card-style.js";
import type { EdgeUiResource } from "./user-messages-card.js";

export const PROGRESS_CARD_URI = "ui://mcp-v3/progress-v6.html";
export const PROGRESS_TOOLS = ["browser_progress", "browser_progress_update", "browser_progress_read"] as const;

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
  .when { flex: none; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .detail { display: block; color: var(--muted); font-size: 12px; font-weight: 400; }
  a { color: inherit; }
  .folded #steps { display: none; }
  .folded h1 { font-weight: 500; color: var(--muted); }
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
<div class="head"><h1 id="title">Etapas</h1><div class="chips"><span class="chip" id="count" hidden></span></div></div>
<ul id="steps"></ul>
<script>
(function () {
  ${CARD_THEME_SCRIPT}
  var ICONS = {
    done: '<svg viewBox="0 0 20 20" aria-label="concluída"><circle cx="10" cy="10" r="9" fill="var(--fg)"/><path d="M6 10.4l2.6 2.6L14.2 7.4" fill="none" stroke="var(--bg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    doing: '<svg viewBox="0 0 20 20" aria-label="em andamento"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)" stroke-width="2"/><path class="spin" d="M10 2a8 8 0 0 1 8 8" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>',
    todo: '<svg viewBox="0 0 20 20" aria-label="a fazer"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="2.6 2.6"/></svg>',
    failed: '<svg viewBox="0 0 20 20" aria-label="falhou"><circle cx="10" cy="10" r="9" fill="var(--bad)"/><path d="M7 7l6 6M13 7l-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
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
    var out = bridge && bridge.toolOutput;
    // browser_progress answers with the plan; mcp_update with the update that moves it.
    var planId = out && (out.planId || (out.update && out.update.planId));
    if (!planId || typeof bridge.callTool !== "function" || document.hidden) return;
    Promise.resolve(bridge.callTool("browser_progress_read", { planId: planId })).then(function (result) {
      var value = result && (result.structuredContent || result);
      if (value && !result.isError && Array.isArray(value.steps)) { latest = value; render(); }
    }).catch(function () {});
  }
  function took(from, to) {
    var start = Date.parse(from);
    var end = to ? Date.parse(to) : Date.now();
    if (!isFinite(start) || !isFinite(end)) return "";
    var minutes = Math.floor(Math.max(0, end - start) / 60000);
    if (minutes < 1) return "<1 min";
    if (minutes < 60) return minutes + " min";
    return Math.floor(minutes / 60) + " h " + (minutes % 60) + " min";
  }
  function openLink(event) {
    var bridge = window.openai;
    if (bridge && typeof bridge.openExternal === "function") {
      event.preventDefault();
      bridge.openExternal({ href: event.currentTarget.href });
    }
  }
  function render() {
    applyTheme();
    var value = data();
    var steps = Array.isArray(value.steps) ? value.steps : [];
    var done = 0;
    steps.forEach(function (step) { if (step && (step.state === "done" || step.state === "skipped")) done += 1; });
    var title = typeof value.title === "string" && value.title.trim() ? value.title : "Etapas";
    // A copy shown earlier in the chat folds into one line; the latest one is below.
    var mine = window.openai && window.openai.toolOutput && window.openai.toolOutput.shownAt;
    var folded = Boolean(latest && mine && latest.shownAt && latest.shownAt !== mine);
    document.body.className = folded ? "folded" : "";
    document.getElementById("title").textContent = folded ? title + ", " + done + "/" + steps.length + ", veja abaixo" : title;
    var count = document.getElementById("count");
    count.hidden = folded || steps.length === 0;
    count.textContent = done + "/" + steps.length;
    var list = document.getElementById("steps");
    list.textContent = "";
    if (folded) return;
    steps.forEach(function (step) {
      if (!step || typeof step.text !== "string") return;
      var state = ICONS[step.state] ? step.state : "todo";
      var li = document.createElement("li");
      li.className = state;
      li.innerHTML = ICONS[state];
      // The list is drawn again every few seconds: start the spinner where the
      // last one was, so it keeps turning instead of jumping back.
      var spin = li.querySelector(".spin");
      if (spin) spin.style.animationDelay = -(Date.now() % 1600) + "ms";
      var span = document.createElement("span");
      span.className = "grow";
      var name = document.createElement(typeof step.link === "string" && step.link.indexOf("https://github.com/") === 0 ? "a" : "span");
      name.textContent = step.text;
      if (name.tagName === "A") { name.href = step.link; name.target = "_blank"; name.rel = "noopener"; name.addEventListener("click", openLink); }
      span.appendChild(name);
      if (typeof step.detail === "string" && step.detail && (state === "doing" || state === "failed")) {
        var detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = step.detail;
        span.appendChild(detail);
      }
      li.appendChild(span);
      var time = step.startedAt && (state === "doing" || step.endedAt) ? took(step.startedAt, state === "doing" ? null : step.endedAt) : "";
      if (time) {
        var when = document.createElement("span");
        when.className = "when";
        when.textContent = time;
        li.appendChild(when);
      }
      list.appendChild(li);
    });
  }
  window.addEventListener("openai:set_globals", render);
  document.addEventListener("visibilitychange", refresh);
  setInterval(refresh, 4000);
  // The minutes of the step in progress go on even when nothing else changes.
  setInterval(render, 30000);
  render();
  refresh();
})();
</script>
<script>${CARD_FIT_SCRIPT}</script>
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

export type ProgressPlanStep = ProgressStep & { startedAt?: string; endedAt?: string };

export interface ProgressPlan {
  planId: string;
  title: string;
  steps: ProgressPlanStep[];
  updatedAt: string;
  shownAt?: string;
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

    const now = this.now().toISOString();
    let plan: ProgressPlan;
    if (name === "browser_progress" && args.planId !== undefined) {
      // The same plan's card again, where the answer is now.
      if (Object.keys(args).some((key) => key !== "planId")) return invalid(id, name);
      const current = plans.find((entry) => entry.planId === args.planId);
      if (!current) return toolError(id, "NOT_FOUND", "No plan with this planId; open one with browser_progress.");
      plan = { ...current, shownAt: now };
      await this.storage.put(key, plans.map((entry) => (entry.planId === plan.planId ? plan : entry)));
      const done = plan.steps.filter((step) => step.state === "done" || step.state === "skipped").length;
      return toolResult(id, `Plan shown again (${done}/${plan.steps.length} done).`, plan);
    }
    const allowed = name === "browser_progress" ? ["title", "steps"] : ["planId", "title", "steps"];
    const input = readPlanInput(args, allowed);
    if (!input) return invalid(id, name);
    if (name === "browser_progress") {
      plan = await this.open(userId, plans, input.title!, input.steps);
    } else {
      const current = plans.find((entry) => entry.planId === args.planId);
      if (!current) return toolError(id, "NOT_FOUND", "No plan with this planId; open one with browser_progress.");
      plan = { ...current, ...(input.title === undefined ? {} : { title: input.title }), steps: timed(current.steps, input.steps, now), updatedAt: now };
      await this.storage.put(key, plans.map((entry) => (entry.planId === plan.planId ? plan : entry)));
    }
    const done = plan.steps.filter((step) => step.state === "done" || step.state === "skipped").length;
    const text = name === "browser_progress"
      ? `Plan shown to the user (planId ${plan.planId}, ${done}/${plan.steps.length} done). Update it with browser_progress_update and this planId; the same card follows.`
      : `Plan updated: ${done}/${plan.steps.length} done.`;
    return toolResult(id, text, plan);
  }

  /**
   * mcp_update action=start without a planId gets its own plan here, before
   * the call goes on to the execution node: its answer shows the card, and
   * the agent never has to remember to open one.
   */
  async openForUpdate(body: unknown, userId: string | undefined): Promise<void> {
    if (!userId || !isRecord(body) || body.method !== "tools/call" || !isRecord(body.params) || body.params.name !== "mcp_update") return;
    const args = body.params.arguments;
    if (!isRecord(args) || args.action !== "start" || args.planId !== undefined) return;
    const plans = (await this.storage.get<ProgressPlan[]>(`progress-plans:${userId}`)) ?? [];
    const plan = await this.open(userId, plans, "Atualizando o MCP",
      [{ text: "Pré-checagem: CI da MAIN, estado da Oracle e do Edge", state: "doing" }]);
    args.planId = plan.planId;
  }

  private async open(userId: string, plans: ProgressPlan[], title: string, steps: ProgressStep[]): Promise<ProgressPlan> {
    const now = this.now().toISOString();
    const plan: ProgressPlan = { planId: this.newId(), title, steps: timed([], steps, now), updatedAt: now, shownAt: now };
    const kept = [...plans, plan].slice(-MAX_PLANS);
    await this.storage.put(`progress-plans:${userId}`, kept);
    for (const dropped of plans.filter((entry) => !kept.includes(entry))) {
      await this.storage.delete(`${OWNER_PREFIX}${dropped.planId}`);
    }
    // A runtime given this planId finds whose plan it moves.
    await this.storage.put(`${OWNER_PREFIX}${plan.planId}`, userId);
    return plan;
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
    const now = this.now().toISOString();
    const plan: ProgressPlan = {
      ...current,
      ...(update.title === undefined ? {} : { title: update.title }),
      steps: timed(current.steps, update.steps, now),
      updatedAt: now,
    };
    await this.storage.put(key, plans.map((entry) => (entry.planId === plan.planId ? plan : entry)));
    return true;
  }
}

/** The new steps, each keeping when it started and ended as the states changed. */
export function timed(previous: readonly ProgressPlanStep[], next: readonly ProgressStep[], now: string): ProgressPlanStep[] {
  return next.map((step, index) => {
    const before = previous[index]?.text === step.text ? previous[index] : previous.find((entry) => entry.text === step.text);
    const startedAt = step.state === "todo" || step.state === "skipped" ? undefined
      : before?.startedAt ?? (step.state === "doing" || before?.state === "doing" ? now : undefined);
    const endedAt = step.state === "done" || step.state === "failed"
      ? before?.endedAt ?? (startedAt === undefined ? undefined : now)
      : undefined;
    return { ...step, ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }) };
  });
}

function readPlanInput(value: Record<string, unknown>, allowed: readonly string[]): { title?: string; steps: ProgressStep[] } | null {
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (allowed.includes("planId") && (typeof value.planId !== "string" || !PLAN_ID.test(value.planId))) return null;
  let title: string | undefined;
  if (value.title !== undefined || !allowed.includes("planId")) {
    title = typeof value.title === "string" ? value.title.trim() : "";
    if (title.length < 1 || title.length > 120) return null;
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 20) return null;
  const steps: ProgressStep[] = [];
  for (const entry of value.steps) {
    const step = parseProgressStep(entry);
    if (!step) return null;
    steps.push(step);
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
