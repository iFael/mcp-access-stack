// The checklist card ChatGPT shows with browser_progress: the plan of the
// work in this conversation, step by step, done, in progress and to do. The
// agent opens it once; browser_progress_update changes the same plan and the
// card, which reads it again every few seconds through browser_progress_read,
// follows. Nothing runs, so the Edge answers these calls itself, even with no
// companion connected, and keeps each user's recent plans. A long operation on
// a runtime that was handed the planId moves the same plan (applyUpdate).
// The Edge notes when each step starts and ends, so the card shows how long
// it took or has been running. Mount the card once per task and update its
// existing rows; other MCP calls must not mount extra copies.

import { parseProgressStep, type ProgressStep, type ProgressUpdate } from "@mcp-access-stack/edge-protocol";
import { CARD_BASE_CSS, CARD_FIT_SCRIPT, CARD_THEME_SCRIPT, CARD_MCP_APPS_SCRIPT } from "./card-style.js";
import type { EdgeUiResource } from "./user-messages-card.js";

export const PROGRESS_CARD_URI = "ui://mcp-v3/progress-v13.html";
export const PROGRESS_TOOLS = ["browser_progress", "browser_progress_update", "browser_progress_read", "browser_user_card"] as const;

const PLAN_ID = /^plan_[0-9a-f-]{36}$/u;
const MAX_PLANS = 20;
const OWNER_PREFIX = "progress-plan-owner:";
// When the newest reply card of each task was shown ("" for none), so older ones fold.
const USER_CARD_PREFIX = "user-card-shown:";
const AUTO_PLAN_PREFIX = "progress-auto-plan:";
const AUTO_SKIP = new Set([
  "browser_progress", "browser_progress_update", "browser_progress_read",
  "browser_user_card", "browser_user_reply", "browser_user_messages", "mcp_update",
]);
const SESSION_PLAN_PREFIX = "progress-plan-sessions:";
const MAX_SESSION_PLANS = 100;
const MAX_USER_CARDS = 50;

export const PROGRESS_CARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CARD_BASE_CSS}
  li { padding: 4px 0; }
  .when { flex: none; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  #activity { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
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
<p id="activity" aria-live="polite" hidden></p>
<ul id="steps"></ul>
<script>${CARD_MCP_APPS_SCRIPT}</script>
<script>
(function () {
  ${CARD_THEME_SCRIPT}
  var ICONS = {
    done: '<svg viewBox="0 0 20 20" aria-label="concluída"><circle cx="10" cy="10" r="9" fill="var(--fg)"/><path d="M6 10.4l2.6 2.6L14.2 7.4" fill="none" stroke="var(--bg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    doing: '<svg viewBox="0 0 20 20" aria-label="em andamento"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)" stroke-width="2"/><path class="spin" d="M10 2a8 8 0 0 1 8 8" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>',
    waiting: '<svg viewBox="0 0 20 20" aria-label="estado não confirmado"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--muted)" stroke-width="1.6"/><path d="M8 7v6m4-6v6" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/></svg>',
    todo: '<svg viewBox="0 0 20 20" aria-label="a fazer"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="2.6 2.6"/></svg>',
    failed: '<svg viewBox="0 0 20 20" aria-label="falhou"><circle cx="10" cy="10" r="9" fill="var(--bad)"/><path d="M7 7l6 6M13 7l-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
    skipped: '<svg viewBox="0 0 20 20" aria-label="pulada"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--muted)" stroke-width="1.6"/><path d="M6 10h8" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/></svg>'
  };
  var latest = null;
  var refreshInFlight = false;
  var refreshStartedAt = 0;
  var refreshSequence = 0;
  var renderedRows = [];
  function data() {
    if (latest) return latest;
    var bridge = (window.mcpV3Card || window.openai) || {};
    var out = bridge.toolOutput;
    if (out && Array.isArray(out.steps)) return out;
    return bridge.toolInput || {};
  }
  // The agent changes the plan with browser_progress_update; the card reads it again.
  function refresh() {
    var bridge = (window.mcpV3Card || window.openai);
    var out = bridge && bridge.toolOutput;
    var planId = out && (Array.isArray(out.steps) && typeof out.updatedAt === "string"
      ? out.planId : out.update && out.update.planId);
    if (!bridge || typeof bridge.callTool !== "function" || document.hidden ||
        (refreshInFlight && Date.now() - refreshStartedAt < 15000)) return;
    refreshInFlight = true;
    refreshStartedAt = Date.now();
    var sequence = ++refreshSequence;
    // Prevent overlapping polls from applying older results after newer ones.
    Promise.resolve().then(function () {
      return bridge.callTool("browser_progress_read", planId ? { planId: planId } : {});
    }).then(function (result) {
      if (sequence !== refreshSequence) return;
      var value = result && (result.structuredContent || result);
      if (value && !result.isError && Array.isArray(value.steps)) { latest = value; render(); }
    }).catch(function () {}).finally(function () {
      if (sequence === refreshSequence) refreshInFlight = false;
    });
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
  // A plan is a status display, not a background execution engine. Only fresh
  // observed MCP activity earns a spinner; silence never proves completion.
  function recentActivity(value) {
    var at = value && value.activity && Date.parse(value.activity.observedAt);
    return isFinite(at) && Date.now() >= at && Date.now() - at < 90000;
  }
  function activityText(value, failed) {
    if (failed) return "Falhou — consulte a etapa indicada antes de retomar.";
    if (!value.activity) return "Aguardando — estado não confirmado até a próxima observação MCP.";
    if (!recentActivity(value)) return "Sem atividade recente — a execução pode continuar no servidor; reconcilie antes de repetir ações.";
    if (value.activity.status === "running") return "Executando — atividade MCP confirmada recentemente.";
    if (value.activity.status === "waiting") return "Aguardando — resultado ou reconciliação pendente.";
    return "Aguardando — nenhuma ferramenta MCP ativa neste momento.";
  }
  function openLink(event) {
    var bridge = (window.mcpV3Card || window.openai);
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
    var mine = (window.mcpV3Card || window.openai) && (window.mcpV3Card || window.openai).toolOutput && (window.mcpV3Card || window.openai).toolOutput.shownAt;
    var folded = Boolean(latest && mine && latest.shownAt && latest.shownAt !== mine);
    document.body.className = folded ? "folded" : "";
    document.getElementById("title").textContent = folded ? title + ", " + done + "/" + steps.length + ", veja abaixo" : title;
    var count = document.getElementById("count");
    count.hidden = folded || steps.length === 0;
    count.textContent = done + "/" + steps.length;
    var pending = steps.some(function (step) { return step && step.state === "doing"; });
    var failed = steps.some(function (step) { return step && step.state === "failed"; });
    var activity = document.getElementById("activity");
    activity.hidden = folded || (!pending && !failed);
    if (!activity.hidden) activity.textContent = activityText(value, failed);
    var list = document.getElementById("steps");
    if (folded) return;
    var visible = steps.filter(function (step) { return step && typeof step.text === "string"; });
    visible.forEach(function (step, index) {
      var state = ICONS[step.state] ? step.state : "todo";
      var live = state === "doing" && value.activity && value.activity.status === "running" && recentActivity(value);
      var signature = JSON.stringify([step.text, state, step.link, step.detail, step.startedAt, step.endedAt, !!live]);
      var observedAt = value.activity && value.activity.observedAt || value.updatedAt;
      var time = step.startedAt && (state === "doing" || step.endedAt)
        ? took(step.startedAt, state === "doing" ? (live ? null : observedAt) : step.endedAt) : "";
      var li = list.children[index];
      if (li && renderedRows[index] === signature) {
        var oldTime = li.querySelector(".when");
        if (oldTime && oldTime.textContent !== time) oldTime.textContent = time;
        return;
      }
      li = document.createElement("li");
      li.className = state;
      li.innerHTML = state === "doing" && !live ? ICONS.waiting : ICONS[state];
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
      if (time) {
        var when = document.createElement("span");
        when.className = "when";
        when.textContent = time;
        li.appendChild(when);
      }
      if (list.children[index]) list.replaceChild(li, list.children[index]);
      else list.appendChild(li);
      renderedRows[index] = signature;
    });
    while (list.children.length > visible.length) list.removeChild(list.lastChild);
    renderedRows.length = visible.length;
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
export interface ProgressActivity { status: "running" | "waiting" | "idle"; observedAt: string; }

export interface ProgressPlan {
  planId: string;
  title: string;
  steps: ProgressPlanStep[];
  updatedAt: string;
  shownAt?: string;
  activity?: ProgressActivity;
}

export interface ProgressStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class ProgressPlans {
  private readonly inFlight = new Map<string, Map<object, number>>();
  private readonly observedFailures = new Set<string>();

  /** A lost transport must not keep an old tool looking active indefinitely. */
  private pruneInFlight(nowMs: number): void {
    for (const [phase, calls] of this.inFlight) {
      for (const [body, startedAt] of calls) {
        if (nowMs < startedAt || nowMs - startedAt >= 90_000) calls.delete(body);
      }
      if (calls.size === 0) this.inFlight.delete(phase);
    }
  }

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

    if (name === "browser_user_card") {
      const taskId = typeof args.taskId === "string" ? args.taskId : "";
      const shown = (await this.storage.get<Record<string, string>>(`${USER_CARD_PREFIX}${userId}`)) ?? {};
      const shownAt = shown[taskId];
      return rpc(id, { content: [{ type: "text", text: `Newest card shown at ${shownAt ?? "never"}.` }], structuredContent: shownAt ? { shownAt } : {} });
    }
    if (name === "browser_progress_read") {
      const planId = typeof args.planId === "string"
        ? args.planId : await this.planForSession(userId, progressSession(body));
      const plan = plans.find((entry) => entry.planId === planId);
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
      // Reusing an existing card also restores its session association after a reconnect/update.
      await this.bindSession(userId, progressSession(body), plan.planId);
      const done = plan.steps.filter((step) => step.state === "done" || step.state === "skipped").length;
      return toolResult(id, `Plan shown again (${done}/${plan.steps.length} done).`, plan);
    }
    const allowed = name === "browser_progress" ? ["title", "steps"] : ["planId", "title", "steps"];
    const input = readPlanInput(args, allowed);
    if (!input) return invalid(id, name);
    if (name === "browser_progress") {
      const existingId = await this.planForSession(userId, progressSession(body));
      const automatic = existingId && await this.storage.get<boolean>(`${AUTO_PLAN_PREFIX}${existingId}`);
      const existing = automatic ? plans.find((entry) => entry.planId === existingId) : undefined;
      if (existing) {
        // Explicit planning adopts the automatically created card.
        plan = { ...existing, title: input.title!, steps: timed(existing.steps, input.steps, now),
          updatedAt: now, shownAt: now };
        await this.storage.put(key, plans.map((entry) => entry.planId === existingId ? plan : entry));
        await this.storage.delete(`${AUTO_PLAN_PREFIX}${existingId}`);
      } else {
        plan = await this.open(userId, plans, input.title!, input.steps);
      }
      await this.bindSession(userId, progressSession(body), plan.planId);
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

  private readonly sessionQueue = new Map<string, Promise<unknown>>();

  /** Serializes first calls so parallel tools in one session cannot open duplicate cards. */
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueue.get(key) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(action);
    this.sessionQueue.set(key, running);
    try { return await running; }
    finally { if (this.sessionQueue.get(key) === running) this.sessionQueue.delete(key); }
  }

  /** A normal MCP tool starts or advances a phase without an agent-side card call. */
  async startTool(body: unknown, userId: string | undefined): Promise<void> {
    const name = progressToolName(body);
    // One native entry point handles ordinary tool progress and update-plan binding.
    if (name === "mcp_update") await this.bindUpdateToPlan(body, userId);
    const session = progressSession(body);
    if (!name || !session || !userId) return;
    const phase = phaseForTool(name);
    if (!phase) return;
    const sessionKey = `${userId}:${session}`;
    const phaseKey = `${sessionKey}:${phase}`;
    this.pruneInFlight(this.now().getTime());
    const calls = this.inFlight.get(phaseKey) ?? new Map<object, number>();
    if (calls.size === 0) this.observedFailures.delete(phaseKey);
    calls.set(body as object, this.now().getTime());
    this.inFlight.set(phaseKey, calls);
    try {
      await this.serial(sessionKey, async () => {
      const existingId = await this.planForSession(userId, session);
      const key = `progress-plans:${userId}`;
      const plans = (await this.storage.get<ProgressPlan[]>(key)) ?? [];
      const existing = plans.find((entry) => entry.planId === existingId);
      const now = this.now().toISOString();
      const activity: ProgressActivity = { status: "running", observedAt: now };
      if (!existing) {
        const plan = await this.open(userId, plans, `MCP V3 — ${phase}`,
          [{ text: phase, state: "doing" }], activity);
        await this.storage.put(`${AUTO_PLAN_PREFIX}${plan.planId}`, true);
        await this.bindSession(userId, session, plan.planId);
        return;
      }
      const automatic = await this.storage.get<boolean>(`${AUTO_PLAN_PREFIX}${existing.planId}`);
      const current = existing.steps.find((step) => step.text === phase);
      const steps = !automatic || current?.state === "doing" || (!current && existing.steps.length >= 20)
        ? existing.steps
        : current
          ? existing.steps.map((step) => step.text === phase ? { text: phase, state: "doing" as const } : step)
          : [...existing.steps, { text: phase, state: "doing" as const }];
      await this.storage.put(key, plans.map((entry) => entry.planId === existing.planId
        ? { ...entry, steps: timed(entry.steps, steps, now), activity, updatedAt: now } : entry));
      });
    } catch (error) {
      calls.delete(body as object);
      if (calls.size === 0) this.inFlight.delete(phaseKey);
      throw error;
    }
  }

  /** Only observed tool outcomes change a phase; the tool response is never rewritten. */
  async finishTool(body: unknown, userId: string | undefined, response: Response): Promise<void> {
    const name = progressToolName(body);
    const session = progressSession(body);
    if (!name || !session || !userId) return;
    const phase = phaseForTool(name);
    if (!phase) return;
    const sessionKey = `${userId}:${session}`;
    const phaseKey = `${sessionKey}:${phase}`;
    let parsed: unknown;
    try { parsed = await response.clone().json(); } catch { /* An unparseable outcome is not success. */ }
    const envelope = isRecord(parsed) ? parsed : {};
    const result = isRecord(envelope.result) ? envelope.result : {};
    const content = isRecord(result.structuredContent) ? result.structuredContent : {};
    const status = typeof content.status === "string" ? content.status
      : isRecord(content.update) && typeof content.update.status === "string"
        ? content.update.status : undefined;
    const nestedState = typeof content.state === "string" ? content.state
      : isRecord(content.task) && typeof content.task.state === "string"
        ? content.task.state : undefined;
    const failed = !response.ok || envelope.error !== undefined || result.isError === true ||
      [status, nestedState].some((value) => ["failed", "failure", "error"].includes(value ?? "")) ||
      content.passed === false || (typeof content.failingCount === "number" && content.failingCount > 0) ||
      (typeof content.exitCode === "number" && content.exitCode !== 0);
    const pending = !failed && (
      !isRecord(parsed) ||
      [status, nestedState].some((value) => [
        "running", "pending", "queued", "in_progress", "started",
        "background_task_started", "handover_started", "confirmation_required",
        "needs_confirmation", "reconciliation_required", "outcome_unknown",
      ].includes(value ?? "")) ||
      content.allCompleted === false ||
      (typeof content.pendingCount === "number" && content.pendingCount > 0)
    );
    this.pruneInFlight(this.now().getTime());
    const calls = this.inFlight.get(phaseKey);
    calls?.delete(body as object);
    const remaining = calls?.size ?? 0;
    if (remaining === 0) this.inFlight.delete(phaseKey);
    if (failed) this.observedFailures.add(phaseKey);
    const anyFailure = this.observedFailures.has(phaseKey);
    if (remaining === 0) this.observedFailures.delete(phaseKey);
    const state: ProgressStep["state"] = remaining > 0 ? "doing" : anyFailure ? "failed" : pending ? "doing" : "done";
    await this.serial(sessionKey, async () => {
      const planId = await this.planForSession(userId, session);
      if (!planId) return;
      const key = `progress-plans:${userId}`;
      const plans = (await this.storage.get<ProgressPlan[]>(key)) ?? [];
      const current = plans.find((entry) => entry.planId === planId);
      if (!current) return;
      const now = this.now().toISOString();
      const active = [...this.inFlight].some(([key, calls]) => key.startsWith(`${sessionKey}:`) && calls.size > 0);
      const activity: ProgressActivity = { status: active ? "running" : pending ? "waiting" : "idle", observedAt: now };
      const automatic = await this.storage.get<boolean>(`${AUTO_PLAN_PREFIX}${planId}`);
      const detail = status === "confirmation_required" || status === "needs_confirmation"
        ? "Aguardando autorização" : status === "reconciliation_required" ||
          status === "outcome_unknown" ? "Aguardando reconciliação" :
          !isRecord(parsed) ? "Resultado não verificável" : undefined;
      const steps = !automatic ? current.steps : current.steps.map((step) => step.text === phase
        ? { text: phase, state, ...(pending && detail ? { detail } : {}) }
        : step);
      // A newer card folds earlier copies of the same task.
      await this.storage.put(key, plans.map((entry) => entry.planId === planId
        ? { ...entry, steps: timed(entry.steps, steps, now), activity, updatedAt: now,
          ...(automatic ? { shownAt: now } : {}) } : entry));
    });
  }

  /** Notes that a reply card of this task is shown now, and says when. */
  async noteUserCard(userId: string, taskId: string | undefined): Promise<string> {
    const now = this.now().toISOString();
    const key = `${USER_CARD_PREFIX}${userId}`;
    const shown = (await this.storage.get<Record<string, string>>(key)) ?? {};
    const task = taskId ?? "";
    delete shown[task];
    const kept = Object.entries({ ...shown, [task]: now }).slice(-MAX_USER_CARDS);
    await this.storage.put(key, Object.fromEntries(kept));
    return now;
  }

  /**
   * mcp_update action=start without a planId gets its own plan here, before
   * the call goes on to the execution node: its answer shows the card, and
   * the agent never has to remember to open one.
   */
  private async bindUpdateToPlan(body: unknown, userId: string | undefined): Promise<void> {
    if (!userId || !isRecord(body) || body.method !== "tools/call" || !isRecord(body.params) || body.params.name !== "mcp_update") return;
    const args = body.params.arguments;
    if (!isRecord(args) || args.action !== "start" || args.planId !== undefined) return;
    const session = progressSession(body);
    const existingId = await this.planForSession(userId, session);
    if (existingId) {
      // The update driver takes over the existing task card instead of opening a second one.
      args.planId = existingId;
      await this.storage.delete(`${AUTO_PLAN_PREFIX}${existingId}`);
      return;
    }
    const plans = (await this.storage.get<ProgressPlan[]>(`progress-plans:${userId}`)) ?? [];
    const plan = await this.open(userId, plans, "Atualizando o MCP",
      [{ text: "Pré-checagem: CI da MAIN, estado da Oracle e do Edge", state: "doing" }]);
    args.planId = plan.planId;
    await this.bindSession(userId, session, plan.planId);
  }

  /** Resolves only plans created by this user and this exact ChatGPT session. */
  async planForSession(userId: string, session: string | undefined): Promise<string | undefined> {
    if (!session) return undefined;
    const assignments = (await this.storage.get<Record<string, string>>(`${SESSION_PLAN_PREFIX}${userId}`)) ?? {};
    const planId = assignments[session];
    if (!planId) return undefined;
    const plans = (await this.storage.get<ProgressPlan[]>(`progress-plans:${userId}`)) ?? [];
    return plans.some((plan) => plan.planId === planId) ? planId : undefined;
  }

  private async bindSession(userId: string, session: string | undefined, planId: string): Promise<void> {
    if (!session) return;
    const key = `${SESSION_PLAN_PREFIX}${userId}`;
    const current = (await this.storage.get<Record<string, string>>(key)) ?? {};
    delete current[session];
    await this.storage.put(key, Object.fromEntries(Object.entries({ ...current, [session]: planId }).slice(-MAX_SESSION_PLANS)));
  }

  private async open(userId: string, plans: ProgressPlan[], title: string, steps: ProgressStep[], activity?: ProgressActivity): Promise<ProgressPlan> {
    const now = this.now().toISOString();
    const plan: ProgressPlan = { planId: this.newId(), title, steps: timed([], steps, now), updatedAt: now, shownAt: now,
      ...(activity ? { activity } : {}) };
    const kept = [...plans, plan].slice(-MAX_PLANS);
    await this.storage.put(`progress-plans:${userId}`, kept);
    for (const dropped of plans.filter((entry) => !kept.includes(entry))) {
      await this.storage.delete(`${OWNER_PREFIX}${dropped.planId}`);
      await this.storage.delete(`${AUTO_PLAN_PREFIX}${dropped.planId}`);
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
      ...(update.steps.some((step) => step.state === "doing") || current.activity
        ? { activity: { status: update.steps.some((step) => step.state === "doing") ? "waiting" as const : "idle" as const, observedAt: now } }
        : {}),
    };
    await this.storage.put(key, plans.map((entry) => (entry.planId === plan.planId ? plan : entry)));
    return true;
  }
}

function progressToolName(body: unknown): string | null {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params) ||
      typeof body.params.name !== "string") return null;
  return body.params.name;
}

function phaseForTool(name: string): string | null {
  if (AUTO_SKIP.has(name) || name.startsWith("companion_internal_")) return null;
  if (name.startsWith("browser_")) return "Pesquisa e navegação";
  if (name.startsWith("github_")) return "GitHub e CI";
  if (name.startsWith("git_")) return "Git e versionamento";
  if (/file|repository|workspace|materializ|memory|document/u.test(name)) return "Arquivos e contexto";
  if (/command|task|test|validation|diagnostic|service|release|oracle|deploy/u.test(name)) {
    return "Execução e diagnóstico";
  }
  return "Consulta MCP V3";
}

/** The session metadata is supplied by ChatGPT to the MCP request, not by the card. */
export function progressSession(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.params) || !isRecord(body.params._meta)) return undefined;
  const meta = body.params._meta;
  const value = meta["openai/session"] ?? meta.sessionId;
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 ? value.trim() : undefined;
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
