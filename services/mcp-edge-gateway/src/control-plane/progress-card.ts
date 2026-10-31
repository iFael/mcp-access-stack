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

export const PROGRESS_CARD_URI = "ui://mcp-v3/progress-v7.html";
export const PROGRESS_TOOLS = ["browser_progress", "browser_progress_update", "browser_progress_read", "browser_user_card"] as const;

const PLAN_ID = /^plan_[0-9a-f-]{36}$/u;
const MAX_PLANS = 20;
const OWNER_PREFIX = "progress-plan-owner:";
// When the newest reply card of each task was shown ("" for none), so older ones fold.
const USER_CARD_PREFIX = "user-card-shown:";
const MAX_USER_CARDS = 50;

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
  /* While steps remain, the user writes to the agent under them. */
  #talk { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .folded #talk { display: none; }
  #sent { display: flex; flex-direction: column; gap: 10px; margin: 0 0 12px; }
  #sent li { display: flex; flex-direction: column; align-items: flex-end; padding: 0; }
  .bubble { max-width: 85%; padding: 8px 12px; border-radius: 16px 16px 4px 16px; background: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
  .state { display: inline-flex; align-items: center; gap: 4px; margin-top: 3px; color: var(--muted); font-size: 11px; }
  .state.done { color: #3b82f6; }
  .state .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--good); }
  .field { display: flex; align-items: flex-end; gap: 6px; padding: 6px 6px 6px 14px; border: 1px solid var(--line); border-radius: 22px; background: var(--soft); }
  .field:focus-within { border-color: var(--muted); }
  textarea { flex: 1; min-width: 0; min-height: 24px; max-height: 140px; margin: 6px 0; padding: 0; border: 0; outline: 0; resize: none; background: transparent; color: var(--fg); font: inherit; line-height: 1.45; }
  textarea::placeholder { color: var(--muted); }
  #send { flex: none; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border-radius: 50%; }
  #send:disabled { opacity: .25; cursor: default; }
  .status { margin: 6px 4px 0; color: var(--muted); font-size: 12px; }
  .status:empty { display: none; }
  .status.bad { color: var(--bad); }
</style>
</head>
<body>
<div class="head"><h1 id="title">Etapas</h1><div class="chips"><span class="chip" id="count" hidden></span></div></div>
<ul id="steps"></ul>
<div id="talk" hidden>
  <ul id="sent" hidden></ul>
  <div class="field">
    <textarea id="text" rows="1" maxlength="2000" placeholder="Escreva para o agente"></textarea>
    <button class="btn primary" id="send" type="button" aria-label="Enviar" title="Enviar" disabled><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>
  <p class="status" id="status"></p>
</div>
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
    var open = steps.some(function (step) { return step && (step.state === "todo" || step.state === "doing" || !ICONS[step.state]); });
    var bridge = window.openai;
    document.getElementById("talk").hidden = folded || !(open || sent.length > 0 && sent.some(waiting)) ||
      !bridge || typeof bridge.callTool !== "function";
    drawSent();
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
  // What the user writes here goes to the agent through browser_user_reply, as
  // in the card of browser_user_messages, and the card asks again, with the
  // same id, until the agent has it.
  var text = document.getElementById("text");
  var send = document.getElementById("send");
  var status = document.getElementById("status");
  var sent = [];
  var busy = false;
  var watching = {};
  function waiting(item) { return !item.deliveredAt && item.watch !== false; }
  function clock(date) { return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0"); }
  function setStatus(message, bad) { status.textContent = message; status.className = bad ? "status bad" : "status"; }
  function save() {
    var bridge = window.openai;
    if (bridge && typeof bridge.setWidgetState === "function") {
      try { bridge.setWidgetState({ sent: sent }); } catch (error) {}
    }
  }
  function restore() {
    var state = window.openai && window.openai.widgetState;
    if (state && Array.isArray(state.sent)) sent = state.sent.filter(function (item) { return item && typeof item.text === "string"; }).slice(-20);
    sent.forEach(watch);
  }
  function drawSent() {
    var list = document.getElementById("sent");
    list.textContent = "";
    sent.forEach(function (item) {
      var li = document.createElement("li");
      var bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = item.text;
      var state = document.createElement("span");
      if (item.deliveredAt) {
        state.className = "state done";
        state.textContent = "✓ Entregue às " + item.deliveredAt;
      } else if (item.watch === false) {
        state.className = "state";
        state.textContent = "Enviado às " + item.at;
      } else {
        state.className = "state";
        state.title = "Chega ao agente com a próxima ação dele.";
        var pulse = document.createElement("span");
        pulse.className = "pulse";
        state.appendChild(pulse);
        state.appendChild(document.createTextNode("Enviado às " + item.at + " · aguardando o agente"));
      }
      li.appendChild(bubble);
      li.appendChild(state);
      list.appendChild(li);
    });
    list.hidden = sent.length === 0;
    text.style.height = "auto";
    text.style.height = Math.min(text.scrollHeight, 140) + "px";
    send.disabled = busy || text.value.trim() === "";
  }
  function watch(item) {
    var bridge = window.openai;
    if (!item.id || !waiting(item) || watching[item.id] || !bridge || typeof bridge.callTool !== "function") return;
    if (typeof item.since === "number" && Date.now() - item.since > 15 * 60000) return;
    watching[item.id] = true;
    var args = { text: item.text, id: item.id };
    function ask() {
      Promise.resolve(bridge.callTool("browser_user_reply", args)).then(function (result) {
        item = sent.filter(function (entry) { return entry.id === args.id; })[0] || item;
        var structured = result && (result.structuredContent || result);
        if (structured && structured.delivered === true) item.deliveredAt = clock(new Date());
        else if (!structured || typeof structured.delivered !== "boolean") item.watch = false;
      }).catch(function () {}).then(function () {
        if (!waiting(item) || Date.now() - item.since > 15 * 60000) {
          delete watching[item.id];
          save();
          render();
          return;
        }
        setTimeout(ask, 4000);
      });
    }
    setTimeout(ask, 2000);
  }
  function submit() {
    var bridge = window.openai;
    var value = text.value.trim();
    if (!value || busy || !bridge || typeof bridge.callTool !== "function") return;
    busy = true;
    setStatus("Enviando…", false);
    drawSent();
    // One id per message: sending it again after ChatGPT lost the answer never delivers it twice.
    var args = { text: value, id: "msg_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36) };
    function attempt(left) {
      return Promise.resolve(bridge.callTool("browser_user_reply", args)).then(function (result) {
        var structured = result && (result.structuredContent || result);
        if (!result || result.isError || !structured || structured.accepted !== true) {
          var detail = result && Array.isArray(result.content) && result.content[0] && result.content[0].text;
          throw new Error(detail || "o MCP recusou a mensagem");
        }
      }).catch(function (error) {
        if (left <= 0) throw error;
        setStatus("O ChatGPT não confirmou; enviando de novo…", false);
        return new Promise(function (resolve) { setTimeout(resolve, 3000); }).then(function () { return attempt(left - 1); });
      });
    }
    attempt(2).then(function () {
      var item = { text: value, at: clock(new Date()), id: args.id, since: Date.now() };
      sent = sent.concat([item]).slice(-20);
      text.value = "";
      setStatus("", false);
      save();
      watch(item);
    }).catch(function (error) {
      setStatus("Não foi enviado: " + (error && error.message ? error.message : String(error)) + ". Tente de novo.", true);
    }).then(function () {
      busy = false;
      render();
    });
  }
  text.addEventListener("input", drawSent);
  // Enter sends, Shift+Enter breaks the line, as in the ChatGPT field.
  text.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  });
  send.addEventListener("click", submit);
  restore();
  window.addEventListener("openai:set_globals", function () { if (sent.length === 0) restore(); render(); });
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

    if (name === "browser_user_card") {
      const taskId = typeof args.taskId === "string" ? args.taskId : "";
      const shown = (await this.storage.get<Record<string, string>>(`${USER_CARD_PREFIX}${userId}`)) ?? {};
      const shownAt = shown[taskId];
      return rpc(id, { content: [{ type: "text", text: `Newest card shown at ${shownAt ?? "never"}.` }], structuredContent: shownAt ? { shownAt } : {} });
    }
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
