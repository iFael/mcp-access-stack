/**
 * Popup controls for sharing the user's own tabs with MCP V3, handing a tab
 * back after a login or CAPTCHA, task notifications, requiring an approved
 * plan before MCP acts, approvals per site, and messages to a running task.
 * Only the user, clicking in the
 * extension popup, can do any of this; neither the bridge nor a page can reach
 * these messages.
 */
export const TAB_SHARING_POPUP_SCRIPT = `"use strict";
(() => {
  const status = document.getElementById("tab-status");
  const share = document.getElementById("tab-share");
  const unshare = document.getElementById("tab-unshare");
  const context = document.getElementById("tab-context");
  const resume = document.getElementById("tab-resume");
  const notify = document.getElementById("tab-notify");
  const requirePlan = document.getElementById("tab-require-plan");
  const confirmDrag = document.getElementById("tab-confirm-drag");
  const approval = document.getElementById("tab-approval");
  const approve = document.getElementById("tab-approve");
  const grants = document.getElementById("tab-grants");
  const revoke = document.getElementById("tab-revoke");
  const autoRow = document.getElementById("tab-auto-row");
  const auto = document.getElementById("tab-auto");
  const autoSites = document.getElementById("tab-auto-sites");
  const question = document.getElementById("task-question");
  const target = document.getElementById("task-target");
  const text = document.getElementById("task-text");
  const send = document.getElementById("task-send");
  const recent = document.getElementById("task-recent");
  const controls = [share, unshare, context, resume, notify, requirePlan, confirmDrag, approve, revoke, auto, send];
  const LABELS = {
    "submit-form": "salvar e confirmar formulários",
    "upload-file": "enviar arquivos",
    "execute-script": "executar JavaScript",
  };
  let tabId;
  async function call(type, extra) {
    const response = await chrome.runtime.sendMessage({ type, tabId, ...extra });
    if (!response || response.ok !== true) throw Error(response?.code || "unavailable");
    return response;
  }
  function renderInbox(inbox) {
    question.hidden = typeof inbox?.question !== "string";
    question.textContent = inbox?.question ? "O MCP perguntou: " + inbox.question : "";
    target.textContent = typeof inbox?.task === "string"
      ? "Vai para a tarefa " + inbox.task + ". O agente recebe na próxima ação, sem parar o que está fazendo."
      : "Nenhuma tarefa do MCP aberta agora. A mensagem vai para a próxima ação do agente.";
    const messages = Array.isArray(inbox?.recent) ? inbox.recent : [];
    recent.hidden = messages.length === 0;
    recent.replaceChildren(...messages.map((message) => {
      const item = document.createElement("li");
      item.textContent = (message.delivered ? "Entregue: " : "Aguardando o agente: ") + message.text;
      return item;
    }));
  }
  function render(state) {
    renderInbox(state.inbox);
    context.checked = state.context === true;
    notify.checked = state.notify === true;
    requirePlan.checked = state.requirePlan === true;
    confirmDrag.checked = state.confirmDrag === true;
    approval.hidden = approve.hidden = typeof state.approval !== "string";
    approval.textContent = state.approval ? "O MCP pediu permissão para " + LABELS[state.approval] + " neste site." : "";
    const granted = Array.isArray(state.grants) ? state.grants : [];
    grants.hidden = revoke.hidden = granted.length === 0;
    grants.textContent = "Liberado neste site: " + granted.map((grant) => LABELS[grant.category] +
      (grant.until === "task" ? " até o fim da tarefa" : " enquanto a aba estiver com o MCP")).join("; ") + ".";
    autoRow.hidden = state.autoEligible !== true;
    auto.checked = state.auto === true;
    const sites = Array.isArray(state.autoSites) ? state.autoSites : [];
    autoSites.hidden = sites.length === 0;
    autoSites.textContent = "Aprovação automática em: " + sites.join(", ") + ".";
    share.hidden = !(state.shareable && !state.shared);
    unshare.hidden = !(state.shared || typeof state.pendingShare === "string");
    resume.hidden = typeof state.waiting !== "string";
    status.textContent = typeof state.pendingShare === "string"
      ? "Você colocou esta aba no grupo " + state.pendingShare + ". Compartilhe para o MCP usar, ou pare para tirá-la do grupo."
      : typeof state.waiting === "string"
      ? "O MCP está esperando você nesta aba: " + state.waiting.replace(/[.!?]?$/u, ".") +
        " Quando terminar, clique em Pronto."
      : state.shared
        ? "Esta aba está compartilhada com o MCP. O MCP pode ler e agir nela, mas nunca a fecha."
        : state.mcp
          ? "Esta aba foi aberta pelo MCP."
          : state.shareable
            ? "Esta aba é só sua. Compartilhe para o MCP trabalhar nela."
            : "Esta aba não pode ser compartilhada: endereço privado, local ou página interna do Chrome.";
  }
  async function refresh() {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = active?.id;
      render(await call("mcp-tab-status"));
    } catch {
      status.textContent = "Canal indisponível. Recarregue a extensão MCP V3.";
    }
  }
  async function act(type, extra) {
    for (const control of controls) control.disabled = true;
    try {
      render(await call(type, extra));
      return true;
    } catch {
      await refresh();
      status.textContent = "Ação recusada. " + status.textContent;
      return false;
    } finally {
      for (const control of controls) control.disabled = false;
    }
  }
  share.addEventListener("click", () => void act("mcp-tab-share"));
  unshare.addEventListener("click", () => void act("mcp-tab-unshare"));
  context.addEventListener("change", () => void act("mcp-tab-context", { enabled: context.checked }));
  notify.addEventListener("change", () => void act("mcp-tab-notify", { enabled: notify.checked }));
  requirePlan.addEventListener("change", () => void act("mcp-tab-require-plan", { enabled: requirePlan.checked }));
  confirmDrag.addEventListener("change", () => void act("mcp-tab-confirm-drag", { enabled: confirmDrag.checked }));
  resume.addEventListener("click", () => void act("mcp-tab-resume"));
  async function sendMessage() {
    if (!text.value.trim()) return;
    if (await act("mcp-tab-message", { text: text.value })) text.value = "";
  }
  send.addEventListener("click", () => void sendMessage());
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void sendMessage();
  });
  approve.addEventListener("click", () => void act("mcp-tab-approve"));
  revoke.addEventListener("click", () => void act("mcp-tab-revoke"));
  auto.addEventListener("change", () => void act("mcp-tab-auto", { enabled: auto.checked }));
  void refresh();
  // Shows when the agent received a message and when it asks something new.
  setInterval(() => void refresh(), 3000);
})();`;
