/**
 * Client-side secret handoff for two pinned first-party configuration forms.
 * The secret never enters MCP tool arguments, bridge messages or logs.
 * Saving either form remains a separate human/production gate.
 */
export const HANDOFF_SECRET_NAME = "MCP_CONTRACT_PREPARE_TOKEN";
export const HANDOFF_EXTENSION_VERSION = "0.3.1";
export const HANDOFF_POPUP_HTML = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP V3 — Credencial segura</title>
<style>
:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101114; color: #f5f5f5; }
body { width: 330px; margin: 0; padding: 16px; font-size: 13px; line-height: 1.5; }
h1 { font-size: 16px; margin: 0 0 8px; } p { color: #bdbdbd; }
button { width: 100%; padding: 10px 12px; margin: 5px 0; border: 1px solid #555; border-radius: 8px; background: #27282d; color: white; cursor: pointer; }
button:disabled { opacity: .55; } #status { min-height: 24px; padding-top: 8px; }
.warning { color: #f2ce81; } code { user-select: all; }
</style></head>
<body>
<h1>MCP V3 · Canal seguro</h1>
<p>Use somente para <code>MCP_CONTRACT_PREPARE_TOKEN</code> no GitHub public-release e no Worker Cloudflare de produção.</p>
<button id="generate" type="button">Gerar novo segredo temporário</button>
<button id="fill" type="button">Preencher campo selecionado</button>
<button id="clear" type="button">Descartar segredo</button>
<p class="warning">O valor nunca será exibido ou copiado. Prepare o formulário, insira o nome exato e selecione o campo Valor. Preencha com este botão ou com Ctrl+Shift+8 (atalho da extensão). Para trocar o valor, descarte-o antes. Salvar no Cloudflare realiza um deploy: precisa de autorização separada.</p>
<div id="status" role="status" aria-live="polite">Carregando…</div>
<script src="secret-provision.js"></script>
</body></html>`;

export const HANDOFF_POPUP_SCRIPT = `"use strict";
const status = document.getElementById("status");
const controls = ["generate", "fill", "clear"];
async function call(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response || response.ok !== true) throw Error(response?.code || "unavailable");
  return response;
}
async function refresh() {
  try {
    const state = await call("mcp-secret-status");
    status.textContent = state.ready
      ? "Segredo temporário disponível por " + Math.ceil(state.remainingSeconds / 60) + " minuto(s)."
      : "Nenhum segredo temporário ativo.";
  } catch {
    status.textContent = "Canal indisponível. Recarregue a extensão MCP V3.";
  }
}
async function action(type) {
  for (const id of controls) document.getElementById(id).disabled = true;
  try {
    const outcome = await call(type);
    status.textContent = type === "mcp-secret-fill"
      ? "Campo preenchido localmente (" + outcome.destination + "). Nenhum formulário foi enviado."
      : type === "mcp-secret-clear"
        ? "Segredo descartado."
        : "Novo segredo gerado localmente. Nenhum valor foi exibido ou transmitido ao MCP.";
    if (type !== "mcp-secret-fill") await refresh();
  } catch {
    status.textContent = "Ação recusada. Confira a URL permitida, o nome e o foco do campo Valor.";
  } finally {
    for (const id of controls) document.getElementById(id).disabled = false;
  }
}
document.getElementById("generate").addEventListener("click", () => void action("mcp-secret-generate"));
document.getElementById("fill").addEventListener("click", () => void action("mcp-secret-fill"));
document.getElementById("clear").addEventListener("click", () => void action("mcp-secret-clear"));
void refresh();`;

/**
 * Runs only in the trusted Chrome extension background service worker.
 * Data is stored in chrome.storage.session (memory-backed, extension-scoped),
 * never local/sync storage. The ephemeral grant lasts at most 15 minutes.
 */
export const HANDOFF_WORKER_SOURCE = `const MCP_SECRET_NAME = "MCP_CONTRACT_PREPARE_TOKEN";
const MCP_SECRET_STORAGE_KEY = "mcpV3EphemeralContractPrepareSecret"; // gitleaks:allow -- storage slot identifier, not the secret value
const MCP_SECRET_TTL_MS = 15 * 60 * 1000;

function mcpSecretDestination(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  if (url.hostname === "github.com" &&
      /^\\/iFael\\/mcp-access-stack\\/settings\\/environments\\/22362070741(?:\\/|$)/u.test(url.pathname)) {
    return "github";
  }
  if (url.hostname === "dash.cloudflare.com" &&
      /^\\/06bfcc0655690697e74ecd3ba200faca\\/workers\\/services\\/view\\/mcp-access-stack\\/production\\/settings\\/?$/u.test(url.pathname)) {
    return "cloudflare";
  }
  return undefined;
}

async function mcpSecretRead() {
  const record = (await chrome.storage.session.get(MCP_SECRET_STORAGE_KEY))[MCP_SECRET_STORAGE_KEY];
  if (!record || typeof record.value !== "string" || !/^[a-f0-9]{96}$/u.test(record.value) ||
      !Number.isSafeInteger(record.createdAt) || record.createdAt > Date.now() ||
      Date.now() - record.createdAt >= MCP_SECRET_TTL_MS) {
    if (record) await chrome.storage.session.remove(MCP_SECRET_STORAGE_KEY);
    return undefined;
  }
  return record;
}

let mcpSecretMutationTail = Promise.resolve();
function mcpSecretMutation(work) {
  // Serialize generation and discard; concurrent popup requests cannot overwrite each other.
  const current = mcpSecretMutationTail.then(work);
  mcpSecretMutationTail = current.then(() => undefined, () => undefined);
  return current;
}

function mcpSecretGenerate() {
  return mcpSecretMutation(async () => {
    // Repeated clicks or uncertain popup outcomes must not silently rotate the value.
    if (await mcpSecretRead()) return { ok: true, ready: true, alreadyExisting: true };
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    bytes.fill(0);
    // Explicitly deny content-script access, including if Chrome defaults change.
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.set({
      [MCP_SECRET_STORAGE_KEY]: { createdAt: Date.now(), value }
    });
    return { ok: true, ready: true };
  });
}

async function mcpSecretStatus() {
  const record = await mcpSecretRead();
  return { ok: true, ready: Boolean(record),
    remainingSeconds: record ? Math.max(0, Math.ceil((MCP_SECRET_TTL_MS - (Date.now() - record.createdAt)) / 1000)) : 0 };
}

async function mcpSecretFill() {
  const record = await mcpSecretRead();
  if (!record) throw Error("expired");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length !== 1 || !Number.isSafeInteger(tabs[0].id)) throw Error("no-tab");
  const destination = mcpSecretDestination(tabs[0].url);
  if (!destination) throw Error("destination-not-allowed");
  const result = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: function mcpFillOnlyFocusedSecretValue(value, target, name) {
      // The second origin check protects against navigation between tab query and injection.
      const url = new URL(location.href);
      if (url.port || url.username || url.password) return "refused";
      const gh = target === "github" && url.protocol === "https:" && url.hostname === "github.com" &&
        /^\\/iFael\\/mcp-access-stack\\/settings\\/environments\\/22362070741(?:\\/|$)/u.test(url.pathname);
      const cf = target === "cloudflare" && url.protocol === "https:" && url.hostname === "dash.cloudflare.com" &&
        /^\\/06bfcc0655690697e74ecd3ba200faca\\/workers\\/services\\/view\\/mcp-access-stack\\/production\\/settings\\/?$/u.test(url.pathname);
      if (!gh && !cf) return "refused";
      const inputs = Array.from(document.querySelectorAll("input"));
      if (!inputs.some(i => i.value?.trim() === name)) return "refused";
      const focused = document.activeElement;
      const isInput = focused instanceof HTMLInputElement;
      const isTextarea = focused instanceof HTMLTextAreaElement;
      if (!isInput && !isTextarea) return "refused";
      if (focused.value || focused.disabled || focused.readOnly) return "refused";
      if (isInput && !["text", "password"].includes(focused.type)) return "refused";
      const label = (focused.name + " " + focused.id + " " + focused.placeholder + " " +
        (focused.getAttribute("aria-label") || "") + " " +
        (focused.labels ? Array.from(focused.labels, x => x.textContent || "").join(" ") : "")).toLowerCase();
      if (!/secret|value|valor|encrypted|conteúdo/u.test(label)) return "refused";
      if (focused.value === name) return "refused";
      const descriptor = Object.getOwnPropertyDescriptor(
        isInput ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value");
      if (!descriptor?.set) return "refused";
      descriptor.set.call(focused, value);
      focused.dispatchEvent(new Event("input", { bubbles: true }));
      focused.dispatchEvent(new Event("change", { bubbles: true }));
      return "filled";
    },
    args: [record.value, destination, MCP_SECRET_NAME],
  });
  if (result?.length !== 1 || result[0]?.result !== "filled") throw Error("field-not-allowed");
  return { ok: true, destination };
}

async function mcpSecretDispatch(message) {
  if (!message || typeof message.type !== "string") throw Error("unsupported");
  if (message.type === "mcp-secret-status") return mcpSecretStatus();
  if (message.type === "mcp-secret-generate") return mcpSecretGenerate();
  if (message.type === "mcp-secret-fill") return mcpSecretFill();
  if (message.type === "mcp-secret-clear") return mcpSecretMutation(async () => {
    await chrome.storage.session.remove(MCP_SECRET_STORAGE_KEY);
    return { ok: true, ready: false };
  });
  throw Error("unsupported");
}

if (chrome.runtime.onMessage?.addListener && chrome.storage?.session) chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Never accept these operations through webpage/bridge or external extension messages.
  if (sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL("secret-provision.html")) return false;
  void mcpSecretDispatch(message).then(
    (result) => reply(result),
    () => reply({ ok: false, code: "refused" }),
  );
  return true;
});
if (chrome.commands?.onCommand?.addListener) chrome.commands.onCommand.addListener(command => {
  if (command !== "fill-mcp-preparation-secret") return;
  void mcpSecretFill().catch(() => undefined);
});`;
