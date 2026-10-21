/**
 * The window where the user approves, trims or rejects a plan MCP proposes
 * with browser_plan. The service worker opens it and accepts decisions only
 * from this extension page, so neither the bridge nor a page can approve.
 */
export const PLAN_REVIEW_HTML = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP V3 · Plano</title>
<style>
:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101114; color: #f5f5f5; }
body { margin: 0; padding: 18px 20px 20px; font-size: 14px; line-height: 1.5; }
h1 { font-size: 18px; margin: 0 0 2px; } h2 { font-size: 14px; margin: 16px 0 6px; }
p { margin: 6px 0; } .muted { color: #9a9aa2; font-size: 12px; }
ol { margin: 4px 0; padding-left: 22px; color: #d6d6d6; }
label { display: flex; gap: 8px; align-items: flex-start; margin: 4px 0; color: #e8e8e8; }
.tag { font-size: 11px; color: #f2ce81; border: 1px solid #6b5a2e; border-radius: 6px; padding: 0 6px; }
.note { color: #bdbdbd; font-size: 12px; border-left: 3px solid #2563eb; padding-left: 10px; margin-top: 14px; }
textarea { box-sizing: border-box; width: 100%; margin-top: 4px; padding: 8px; border-radius: 8px;
  border: 1px solid #444; background: #1b1c21; color: inherit; font: inherit; resize: vertical; }
.buttons { display: flex; gap: 10px; margin-top: 14px; }
button { flex: 1; padding: 10px 12px; border: 1px solid #555; border-radius: 8px; background: #27282d; color: white; cursor: pointer; font: inherit; }
button.primary { background: #2563eb; border-color: #2563eb; }
button:disabled { opacity: .5; cursor: default; } #status { min-height: 22px; margin-top: 10px; }
</style></head>
<body>
<h1>O MCP propõe um plano</h1>
<p id="task" class="muted"></p>
<p id="summary"></p>
<h2>Passos</h2>
<ol id="steps"></ol>
<h2>Sites</h2>
<p class="muted">Cada site inclui os subdomínios. Desmarque o que não quiser liberar.</p>
<div id="domains"></div>
<h2>O que o MCP poderá fazer nesses sites</h2>
<label><input type="checkbox" checked disabled> Ler as páginas (sempre incluído)</label>
<div id="actions"></div>
<p id="tabs" class="muted" hidden></p>
<p class="note">Fora destes sites e ações, o MCP fica bloqueado até você aprovar um novo plano. Ações sensíveis continuam pedindo confirmação, como hoje.</p>
<label for="feedback" style="display:block;margin-top:14px">Comentário para o MCP (opcional)</label>
<textarea id="feedback" maxlength="500" rows="3"></textarea>
<div class="buttons">
<button id="reject" type="button">Recusar</button>
<button id="approve" type="button" class="primary">Aprovar plano</button>
</div>
<p id="status" role="status" aria-live="polite">Carregando…</p>
<script src="plan-review.js"></script>
</body></html>`;

export const PLAN_REVIEW_SCRIPT = `"use strict";
(() => {
  const LABELS = {
    navigate: "Abrir abas e navegar entre páginas",
    interact: "Clicar, rolar, arrastar e usar o teclado",
    fill: "Digitar e preencher formulários",
    upload: "Enviar arquivos",
    download: "Baixar arquivos",
    evaluate: "Executar JavaScript nas páginas",
  };
  const SENSITIVE = new Set(["upload", "download", "evaluate"]);
  const planId = location.hash.slice(1);
  const byId = (id) => document.getElementById(id);
  const approve = byId("approve");
  const reject = byId("reject");
  const status = byId("status");
  function option(container, value, label, sensitive) {
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.value = value;
    box.addEventListener("change", update);
    row.append(box, " " + label);
    if (sensitive) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "sensível";
      row.append(" ", tag);
    }
    container.append(row);
  }
  function checked(id) {
    return Array.from(byId(id).querySelectorAll("input:checked"), (box) => box.value);
  }
  function update() {
    approve.disabled = checked("domains").length === 0;
    reject.disabled = false;
    status.textContent = approve.disabled ? "Deixe pelo menos um site marcado para aprovar." : "";
  }
  function finish(text) {
    for (const control of document.querySelectorAll("input, textarea, button")) control.disabled = true;
    status.textContent = text;
  }
  async function decide(approved) {
    approve.disabled = true;
    reject.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "mcp-plan-decide", planId, approve: approved,
        domains: checked("domains"), actions: checked("actions"),
        feedback: byId("feedback").value.trim().slice(0, 500),
      });
      if (!response || response.ok !== true) throw Error(response?.code || "refused");
      finish(approved ? "Plano aprovado. O MCP já pode seguir." : "Plano recusado. O MCP foi avisado.");
      setTimeout(() => window.close(), 1500);
    } catch {
      update();
      status.textContent = "Não foi possível registrar sua decisão. O plano pode ter sido substituído ou encerrado.";
    }
  }
  async function load() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "mcp-plan-get", planId });
      if (!response || response.ok !== true) throw Error("missing");
      const plan = response.plan;
      byId("task").textContent = "Tarefa " + plan.taskId;
      byId("summary").textContent = plan.summary;
      for (const step of plan.steps) {
        const item = document.createElement("li");
        item.textContent = step;
        byId("steps").append(item);
      }
      for (const domain of plan.domains) option(byId("domains"), domain, domain, false);
      for (const action of plan.actions) option(byId("actions"), action, LABELS[action] || action, SENSITIVE.has(action));
      if (plan.tabs.length > 0) {
        byId("tabs").hidden = false;
        byId("tabs").textContent = "Vale também nas abas que você compartilhou: " + plan.tabs.join(", ") + ".";
      }
      if (plan.status === "pending") update();
      else finish("Este plano já foi decidido ou substituído.");
    } catch {
      finish("Este plano não está mais disponível.");
    }
  }
  approve.addEventListener("click", () => void decide(true));
  reject.addEventListener("click", () => void decide(false));
  void load();
})();`;
