/** Minimal status and explicit stop control; browser permissions remain guarded in the worker. */
export const TAB_SHARING_POPUP_SCRIPT = `"use strict";
(() => {
  const status = document.getElementById("tab-status");
  const stop = document.getElementById("tab-stop");
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
    } catch {
      status.textContent = "Não foi possível consultar o status.";
    }
  }
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