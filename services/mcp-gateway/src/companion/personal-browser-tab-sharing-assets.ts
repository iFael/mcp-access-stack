/**
 * Popup controls for sharing the user's own tabs with MCP V3, handing a tab
 * back after a login or CAPTCHA, task notifications, and requiring an approved
 * plan before MCP acts. Only the user, clicking in the extension popup, can do
 * any of this; neither the bridge nor a page can reach these messages.
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
  const controls = [share, unshare, context, resume, notify, requirePlan];
  let tabId;
  async function call(type, extra) {
    const response = await chrome.runtime.sendMessage({ type, tabId, ...extra });
    if (!response || response.ok !== true) throw Error(response?.code || "unavailable");
    return response;
  }
  function render(state) {
    context.checked = state.context === true;
    notify.checked = state.notify === true;
    requirePlan.checked = state.requirePlan === true;
    share.hidden = !(state.shareable && !state.shared);
    unshare.hidden = !state.shared;
    resume.hidden = typeof state.waiting !== "string";
    status.textContent = typeof state.waiting === "string"
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
    } catch {
      await refresh();
      status.textContent = "Ação recusada. " + status.textContent;
    } finally {
      for (const control of controls) control.disabled = false;
    }
  }
  share.addEventListener("click", () => void act("mcp-tab-share"));
  unshare.addEventListener("click", () => void act("mcp-tab-unshare"));
  context.addEventListener("change", () => void act("mcp-tab-context", { enabled: context.checked }));
  notify.addEventListener("change", () => void act("mcp-tab-notify", { enabled: notify.checked }));
  requirePlan.addEventListener("change", () => void act("mcp-tab-require-plan", { enabled: requirePlan.checked }));
  resume.addEventListener("click", () => void act("mcp-tab-resume"));
  void refresh();
})();`;
