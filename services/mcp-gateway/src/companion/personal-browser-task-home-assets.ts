/**
 * The first tab of a task's group. Chrome has no empty tab groups, so when the
 * user approves a plan the extension opens this page to start the task's group
 * before MCP opens any site, as Claude's own browser tool does. It tells the
 * user that tabs dragged into the group are shared with the task. The first
 * browser_open of the task navigates this tab instead of opening another.
 */
export const TASK_HOME_HTML = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP · tarefa</title>
<style>
:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101114; color: #f5f5f5; }
body { margin: 0 auto; max-width: 640px; padding: 40px 24px; font-size: 15px; line-height: 1.55; }
h1 { font-size: 20px; margin: 0 0 6px; } p { margin: 8px 0; } .muted { color: #9a9aa2; font-size: 13px; }
.note { color: #d6d6d6; border-left: 3px solid #2563eb; padding-left: 12px; margin-top: 20px; }
</style></head>
<body>
<h1 id="title">MCP · tarefa</h1>
<p id="summary"></p>
<p id="sites" class="muted"></p>
<p class="note">Arraste para este grupo as abas que o MCP pode usar nesta tarefa. Tirar uma aba do grupo devolve a aba para você, sem fechar.</p>
<p class="muted">O MCP vai usar esta aba para abrir o primeiro site da tarefa.</p>
<script src="task-home.js"></script>
</body></html>`;

export const TASK_HOME_SCRIPT = `"use strict";
(async () => {
  const taskId = decodeURIComponent(location.hash.slice(1));
  try {
    const response = await chrome.runtime.sendMessage({ type: "mcp-home-get", taskId });
    if (!response || response.ok !== true) return;
    document.getElementById("title").textContent = response.title;
    document.title = response.title;
    document.getElementById("summary").textContent = response.summary;
    document.getElementById("sites").textContent = "Sites aprovados: " + response.domains.join(", ");
  } catch {
    // The page still explains the group without the plan details.
  }
})();`;
