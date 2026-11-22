/** Minimal status and explicit stop control; browser permissions remain guarded in the worker. */
export const TAB_SHARING_POPUP_SCRIPT = `"use strict";
(() => {
  const status = document.getElementById("tab-status");
  const stop = document.getElementById("tab-stop");
  const revoke = document.getElementById("tab-revoke");
  let tabId;
  async function refresh() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
      if (!Number.isInteger(tabId)) throw Error("no-tab");
      const response = await chrome.runtime.sendMessage({ type: "mcp-tab-status", tabId });
      if (!response?.ok) throw Error("unavailable");
      status.textContent = response.mcp ? "MCP trabalhando nesta aba."
        : response.shared ? "Esta aba está compartilhada com o MCP."
        : "Nenhuma tarefa do MCP nesta aba.";
      if (response.permanentScript) status.textContent += " JavaScript lembrado neste site.";
      revoke.hidden = !(response.permanentScript || (response.grants?.length ?? 0) > 0);
    } catch {
      status.textContent = "Não foi possível consultar o status.";
    }
  }
  revoke.addEventListener("click", async () => {
    revoke.disabled = true;
    try {
      if (!Number.isInteger(tabId)) throw Error("no-tab");
      const response = await chrome.runtime.sendMessage({ type: "mcp-tab-revoke", tabId });
      if (!response?.ok) throw Error("refused");
      await refresh();
    } catch {
      status.textContent = "Não foi possível revogar a autorização deste site.";
    } finally { revoke.disabled = false; }
  });
  stop.addEventListener("click", async () => {
    stop.disabled = true;
    try {
      if (!Number.isInteger(tabId)) throw Error("no-tab");
      const response = await chrome.runtime.sendMessage({ type: "mcp-tab-stop", tabId });
      if (!response?.ok) throw Error("refused");
      status.textContent = "MCP parado. Todas as abas foram preservadas.";
    } catch {
      status.textContent = "Não foi possível parar a tarefa do MCP.";
    } finally { stop.disabled = false; }
  });
  void refresh();
})();`;