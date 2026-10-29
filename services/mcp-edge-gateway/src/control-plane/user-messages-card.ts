// The card ChatGPT shows with the result of browser_user_messages: the agent's
// question, if any, its options as buttons, and a field where the user writes to the task without
// interrupting it. What they send goes through browser_user_reply to the same
// inbox as the extension popup, and reaches the agent with its next call.
// Only tools whose _meta.ui.resourceUri names this card make the Edge serve it.

import { CARD_BASE_CSS } from "./card-style.js";
import { PROGRESS_CARD_RESOURCE, PROGRESS_CARD_URI } from "./progress-card.js";
import { PULL_REQUEST_CARD_RESOURCE, PULL_REQUEST_CARD_URI } from "./pull-request-card.js";

export const USER_MESSAGES_CARD_URI = "ui://mcp-v3/user-messages-v2.html";
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
  .task { color: var(--muted); font-size: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
  .question { margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; background: var(--soft); white-space: pre-wrap; }
  .question b { display: block; font-size: 12px; color: var(--muted); font-weight: 600; }
  #options { display: flex; flex-direction: column; gap: 6px; margin: 0 0 10px; }
  #options button { text-align: left; background: var(--soft); color: var(--fg); border: 1px solid var(--line); font-weight: 400; }
  #options button.chosen { border-color: var(--accent); font-weight: 600; }
  textarea { width: 100%; min-height: 64px; resize: vertical; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
  .row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  button { padding: 7px 14px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  .status { color: var(--muted); font-size: 12px; }
  .status.bad { color: var(--bad); }
  #sent { margin-top: 10px; }
  #sent li { display: block; padding: 6px 0; border-top: 1px solid var(--line); white-space: pre-wrap; }
  li small { display: block; color: var(--muted); }
</style>
</head>
<body>
<div class="head"><h1>Conversa com a tarefa</h1></div>
<div class="task" id="task">O agente continua trabalhando enquanto você escreve.</div>
<p class="question" id="question" hidden><b>O agente pergunta</b><span id="question-text"></span></p>
<div id="options" hidden></div>
<div id="composer">
  <textarea id="text" maxlength="2000" placeholder="Escreva para o agente sem interromper a tarefa"></textarea>
  <div class="row"><button id="send" type="button">Enviar</button><span class="status" id="status"></span></div>
</div>
<p class="status" id="unavailable" hidden>Este app não deixa o cartão enviar mensagens. Responda pelo ícone da extensão MCP V3 no Chrome.</p>
<ul id="sent"></ul>
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
    var doing = choices.length > 0
      ? "O agente parou e espera sua escolha. Escolha uma opção ou escreva abaixo; a resposta entra nesta conversa."
      : "O agente continua trabalhando enquanto você escreve.";
    document.getElementById("task").textContent = typeof args.taskId === "string" ? "Tarefa " + args.taskId + ". " + doing : doing;
    var box = document.getElementById("options");
    box.textContent = "";
    box.hidden = choices.length === 0;
    choices.forEach(function (label, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = String.fromCharCode(65 + index) + ") " + label;
      if (chosen === index) button.className = "chosen";
      button.disabled = busy || chosen !== null || !bridge || typeof bridge.callTool !== "function";
      button.addEventListener("click", function () { submit("Escolho " + button.textContent, index); });
      box.appendChild(button);
    });
    var question = typeof args.question === "string" ? args.question.trim() : "";
    document.getElementById("question").hidden = question === "";
    document.getElementById("question-text").textContent = question;
    var list = document.getElementById("sent");
    list.textContent = "";
    sent.slice().reverse().forEach(function (item) {
      var li = document.createElement("li");
      var when = document.createElement("small");
      when.textContent = "Enviado às " + item.at + ". Chega ao agente com a próxima ação dele.";
      li.textContent = item.text;
      li.appendChild(when);
      list.appendChild(li);
    });
    send.disabled = busy || text.value.trim() === "";
  }
  function restore() {
    var state = bridge && bridge.widgetState;
    if (state && Array.isArray(state.sent)) sent = state.sent.filter(function (item) { return item && typeof item.text === "string"; }).slice(-20);
    if (state && typeof state.chosen === "number") chosen = state.chosen;
  }

  if (!bridge || typeof bridge.callTool !== "function") {
    document.getElementById("composer").hidden = true;
    document.getElementById("unavailable").hidden = false;
  }

  text.addEventListener("input", render);
  text.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send.click(); }
  });
  send.addEventListener("click", function () { submit(text.value.trim(), null); });
  function submit(value, choice) {
    if (!value || busy || !bridge) return;
    busy = true;
    setStatus("Enviando…", false);
    render();
    var args = { text: value };
    if (typeof input().taskId === "string") args.taskId = input().taskId;
    Promise.resolve(bridge.callTool("browser_user_reply", args)).then(function (result) {
      var structured = result && (result.structuredContent || result);
      if (!result || result.isError || !structured || structured.accepted !== true) {
        var detail = result && Array.isArray(result.content) && result.content[0] && result.content[0].text;
        throw new Error(detail || "o MCP recusou a mensagem");
      }
      var now = new Date();
      sent.push({ text: value, at: String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") });
      sent = sent.slice(-20);
      if (choice === null) text.value = "";
      else chosen = choice;
      setStatus("Enviado.", false);
      if (typeof bridge.setWidgetState === "function") {
        try { bridge.setWidgetState({ sent: sent, chosen: chosen }); } catch (error) {}
      }
    }).catch(function (error) {
      setStatus("Não foi enviado: " + (error && error.message ? error.message : String(error)) + ". Tente de novo ou use o popup da extensão.", true);
    }).then(function () {
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
