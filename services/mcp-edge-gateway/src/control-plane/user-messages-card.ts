// The card ChatGPT shows with the result of browser_user_messages: the agent's
// question, if any, its options as buttons, and a field where the user writes to the task without
// interrupting it. What they send goes through browser_user_reply to the same
// inbox as the extension popup, and reaches the agent with its next call.
// Only tools whose _meta.ui.resourceUri names this card make the Edge serve it.

import { CARD_BASE_CSS } from "./card-style.js";
import { PROGRESS_CARD_RESOURCE, PROGRESS_CARD_URI } from "./progress-card.js";
import { PULL_REQUEST_CARD_RESOURCE, PULL_REQUEST_CARD_URI } from "./pull-request-card.js";

export const USER_MESSAGES_CARD_URI = "ui://mcp-v3/user-messages-v5.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export interface EdgeUiResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
  _meta: Record<string, unknown>;
}

export const USER_MESSAGES_CARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${CARD_BASE_CSS}
  .question { margin: 0 0 12px; font-size: 15px; font-weight: 600; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
  #options { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
  #options .chosen { border-color: var(--fg); font-weight: 600; }
  #options .btn:disabled:not(.chosen) { opacity: .45; }
  #sent { display: flex; flex-direction: column; gap: 10px; margin: 0 0 12px; }
  #sent li { display: flex; flex-direction: column; align-items: flex-end; padding: 0; }
  .bubble { max-width: 85%; padding: 8px 12px; border-radius: 16px 16px 4px 16px; background: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
  .state { display: inline-flex; align-items: center; gap: 4px; margin-top: 3px; color: var(--muted); font-size: 11px; }
  .state.done { color: var(--good); }
  .state .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--warn); }
  .field { display: flex; align-items: flex-end; gap: 6px; padding: 6px 6px 6px 14px; border: 1px solid var(--line); border-radius: 22px; background: var(--soft); }
  .field:focus-within { border-color: var(--muted); }
  textarea { flex: 1; min-height: 24px; max-height: 140px; margin: 6px 0; padding: 0; border: 0; outline: 0; resize: none; background: transparent; color: var(--fg); font: inherit; line-height: 1.45; }
  textarea::placeholder { color: var(--muted); }
  #send { flex: none; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border-radius: 50%; }
  #send:disabled { opacity: .25; cursor: default; }
  .status { min-height: 0; margin: 6px 4px 0; color: var(--muted); font-size: 12px; }
  .status:empty { display: none; }
  .status.bad { color: var(--bad); }
</style>
</head>
<body>
<p class="question" id="question" hidden></p>
<div id="options" hidden></div>
<ul id="sent"></ul>
<div id="composer">
  <div class="field">
    <textarea id="text" rows="1" maxlength="2000" placeholder="Escreva para o agente"></textarea>
    <button class="btn primary" id="send" type="button" aria-label="Enviar" title="Enviar"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>
  <p class="status" id="status"></p>
</div>
<p class="status" id="unavailable" hidden>Este app não deixa o cartão enviar mensagens. Responda pelo ícone da extensão MCP V3 no Chrome.</p>
<script>
(function () {
  var bridge = window.openai;
  var text = document.getElementById("text");
  var send = document.getElementById("send");
  var status = document.getElementById("status");
  var sent = [];
  var chosen = null;
  var busy = false;

  function input() { return (bridge && bridge.toolInput) || {}; }
  function options() {
    var list = input().options;
    return Array.isArray(list) ? list.filter(function (item) { return typeof item === "string" && item.trim(); }).slice(0, 4) : [];
  }
  function setStatus(message, bad) { status.textContent = message; status.className = bad ? "status bad" : "status"; }
  function render() {
    if (bridge && (bridge.theme === "dark" || bridge.theme === "light")) document.documentElement.setAttribute("data-theme", bridge.theme);
    var args = input();
    var choices = options();
    var question = typeof args.question === "string" ? args.question.trim() : "";
    var asking = document.getElementById("question");
    asking.hidden = question === "";
    asking.textContent = question;
    var box = document.getElementById("options");
    box.textContent = "";
    box.hidden = choices.length === 0;
    choices.forEach(function (label, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      if (chosen === index) {
        button.className = "btn chosen";
        button.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      button.appendChild(document.createTextNode(label));
      button.disabled = busy || chosen !== null || !bridge || typeof bridge.callTool !== "function";
      button.addEventListener("click", function () { submit("Escolho " + label, index); });
      box.appendChild(button);
    });
    text.placeholder = choices.length > 0 ? "Ou escreva outra resposta" : "Escreva para o agente";
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
        state.title = "Chega ao agente quando a ação dele em andamento terminar.";
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
  function restore() {
    var state = bridge && bridge.widgetState;
    if (state && Array.isArray(state.sent)) sent = state.sent.filter(function (item) { return item && typeof item.text === "string"; }).slice(-20);
    if (state && typeof state.chosen === "number") chosen = state.chosen;
    sent.forEach(watch);
  }
  function clock(date) { return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0"); }
  function save() {
    if (typeof bridge.setWidgetState === "function") {
      try { bridge.setWidgetState({ sent: sent, chosen: chosen }); } catch (error) {}
    }
  }
  // Asks the companion, with the same id, whether the agent has the message yet. Asking again never
  // sends it twice. An older companion does not say, and then the card stops asking.
  var watching = {};
  function watch(item) {
    if (!item.id || item.deliveredAt || item.watch === false || watching[item.id] || !bridge || typeof bridge.callTool !== "function") return;
    if (typeof item.since === "number" && Date.now() - item.since > 15 * 60000) return;
    watching[item.id] = true;
    var args = { text: item.text, id: item.id };
    if (typeof item.taskId === "string") args.taskId = item.taskId;
    function ask() {
      Promise.resolve(bridge.callTool("browser_user_reply", args)).then(function (result) {
        // The list may have been restored meanwhile: mark the message it holds now.
        item = sent.filter(function (entry) { return entry.id === args.id; })[0] || item;
        var structured = result && (result.structuredContent || result);
        if (structured && structured.delivered === true) {
          item.deliveredAt = clock(new Date());
        } else if (!structured || typeof structured.delivered !== "boolean") {
          item.watch = false;
        }
      }).catch(function () {}).then(function () {
        if (item.deliveredAt || item.watch === false || Date.now() - item.since > 15 * 60000) {
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

  if (!bridge || typeof bridge.callTool !== "function") {
    document.getElementById("composer").hidden = true;
    document.getElementById("unavailable").hidden = false;
  }

  text.addEventListener("input", render);
  // Enter sends, Shift+Enter breaks the line, as in the ChatGPT field.
  text.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send.click(); }
  });
  send.addEventListener("click", function () { submit(text.value.trim(), null); });
  function submit(value, choice) {
    if (!value || busy || !bridge) return;
    busy = true;
    setStatus("Enviando…", false);
    // ChatGPT may take long to answer the card, or never answer it, even when the message arrived.
    var slow = setTimeout(function () {
      if (busy) setStatus("O ChatGPT ainda não confirmou o envio. Se não aparecer na conversa em 1 minuto, escreva no popup da extensão.", false);
    }, 20000);
    render();
    // One id per message: sending it again after ChatGPT lost the answer never delivers it twice.
    var args = { text: value, id: "msg_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36) };
    if (typeof input().taskId === "string") args.taskId = input().taskId;
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
      if (typeof args.taskId === "string") item.taskId = args.taskId;
      sent.push(item);
      sent = sent.slice(-20);
      if (choice === null) text.value = "";
      else chosen = choice;
      setStatus("", false);
      save();
      watch(item);
    }).catch(function (error) {
      setStatus("Não foi enviado: " + (error && error.message ? error.message : String(error)) + ". Tente de novo ou use o popup da extensão.", true);
    }).then(function () {
      clearTimeout(slow);
      busy = false;
      render();
    });
  }
  window.addEventListener("openai:set_globals", function () { restore(); render(); });
  restore();
  render();
})();
</script>
</body>
</html>
`;

const UI_RESOURCES: Readonly<Record<string, EdgeUiResource>> = {
  [PROGRESS_CARD_URI]: PROGRESS_CARD_RESOURCE,
  [PULL_REQUEST_CARD_URI]: PULL_REQUEST_CARD_RESOURCE,
  [USER_MESSAGES_CARD_URI]: {
    uri: USER_MESSAGES_CARD_URI,
    name: "Conversa com a tarefa",
    description: "Lets the user answer the agent and write to a running task from the chat.",
    mimeType: MCP_APP_MIME_TYPE,
    text: USER_MESSAGES_CARD_HTML,
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetPrefersBorder": true,
      "openai/widgetDescription": "A reply box for the running task; what the user sends reaches the agent with its next tool call.",
    },
  },
};

/** The cards the manifest's tools point at and the Edge knows how to serve. */
export function uiResourcesForManifest(
  manifest: readonly { name: string; _meta?: unknown }[],
): EdgeUiResource[] {
  const uris = new Set<string>();
  for (const tool of manifest) {
    const meta = isRecord(tool._meta) ? tool._meta : {};
    const ui = isRecord(meta.ui) ? meta.ui : {};
    if (typeof ui.resourceUri === "string") uris.add(ui.resourceUri);
    if (typeof meta["openai/outputTemplate"] === "string") uris.add(meta["openai/outputTemplate"]);
  }
  return [...uris].flatMap((uri) => (Object.hasOwn(UI_RESOURCES, uri) ? [UI_RESOURCES[uri]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
