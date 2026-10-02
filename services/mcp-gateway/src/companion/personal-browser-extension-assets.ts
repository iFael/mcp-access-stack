export interface PersonalBrowserExtensionAssets {
  manifest: string;
  serviceWorker: string;
}

export function buildPersonalBrowserExtensionAssets(
  token: string,
  port: number,
): PersonalBrowserExtensionAssets {
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: "MCP V3 Personal Browser",
    version: "0.1.0",
    description: "Connects explicitly MCP-owned tabs in your personal Chrome profile to MCP V3.",
    minimum_chrome_version: "116",
    permissions: ["tabs", "scripting", "storage"],
    host_permissions: ["http://*/*", "https://*/*"],
    background: { service_worker: "service-worker.js" },
    action: { default_title: "MCP V3 Personal Browser" },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:" + port,
    },
  }, null, 2) + "\n";

  const serviceWorker = `"use strict";

const BRIDGE_TOKEN = ${JSON.stringify(token)};
const BRIDGE_PORT = ${port};
const BRIDGE_URL = "ws://127.0.0.1:" + BRIDGE_PORT + "/?token=" + encodeURIComponent(BRIDGE_TOKEN);
const PERSONAL_PREFIX = "personal:";
const OWNED_TABS_KEY = "mcpV3OwnedTabs";

let socket;
let reconnectTimer;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(BRIDGE_URL);
  socket.onopen = () => send({ type: "hello", browser: "chrome", profile: "personal" });
  socket.onmessage = (event) => {
    void handleMessage(event.data);
  };
  socket.onerror = () => undefined;
  socket.onclose = () => {
    socket = undefined;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  };
}

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (message?.type !== "request" || typeof message.id !== "string") return;
  try {
    const result = await perform(String(message.operation), message.input ?? {});
    send({ type: "response", id: message.id, ok: true, result });
  } catch (error) {
    send({
      type: "response",
      id: message.id,
      ok: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function perform(operation, input) {
  switch (operation) {
    case "tabs": return tabs(input);
    case "open": return open(input);
    case "navigate": return navigate(input);
    case "snapshot": return snapshot(input);
    case "click": return click(input);
    case "fill": return fill(input);
    case "press": return press(input);
    case "wait": return wait(input);
    case "extract": return extract(input);
    case "sequence": return sequence(input);
    case "goBack": return goBack(input);
    case "goForward": return goForward(input);
    case "closeTab": return closeTab(input);
    case "finishTask": return finishTask(input);
    default: throw coded("BROWSER_CAPABILITY_UNSUPPORTED", operation + " is not supported by personal browser mode.");
  }
}

async function tabs(input) {
  const owned = await readOwnedTabs();
  const result = [];
  let changed = false;
  for (const [key, metadata] of Object.entries(owned)) {
    if (input.taskId && metadata.taskId !== input.taskId) continue;
    const chromeTabId = Number(key);
    const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
    if (!tab) {
      delete owned[key];
      changed = true;
      continue;
    }
    result.push(toBrowserTab(metadata, tab));
  }
  if (changed) await writeOwnedTabs(owned);
  return { tabs: result };
}

async function open(input) {
  if (typeof input.url !== "string" ||
      (!input.url.startsWith("http://") && !input.url.startsWith("https://"))) {
    throw coded("INVALID_ARGUMENT", "Personal browser mode requires an explicit http(s) URL.");
  }
  if (input.url === "about:blank") {
    throw coded("NAVIGATION_BLOCKED", "about:blank is not a valid personal browser target.");
  }
  const owned = await readOwnedTabs();
  if (input.reusable) {
    for (const [key, metadata] of Object.entries(owned)) {
      if (metadata.taskId !== input.taskId || metadata.purpose !== (input.purpose ?? input.url)) continue;
      const chromeTabId = Number(key);
      const existing = await chrome.tabs.get(chromeTabId).catch(() => undefined);
      if (!existing) {
        delete owned[key];
        continue;
      }
      await chrome.tabs.update(chromeTabId, { active: true });
      metadata.lastUsedAt = new Date().toISOString();
      owned[key] = metadata;
      await writeOwnedTabs(owned);
      return { tab: toBrowserTab(metadata, existing), restoredFromCache: true };
    }
  }

  const tab = await chrome.tabs.create({ url: input.url, active: true });
  if (typeof tab.id !== "number") throw coded("INTERNAL_ERROR", "Chrome did not return a tab id.");
  await waitForTabComplete(tab.id, 30000).catch(() => undefined);
  const refreshed = await chrome.tabs.get(tab.id);
  const now = new Date().toISOString();
  const metadata = {
    tabId: PERSONAL_PREFIX + tab.id,
    ...(typeof input.taskId === "string" ? { taskId: input.taskId } : {}),
    lifecycle: typeof input.taskId === "string" ? "task-scoped" : "persistent",
    ownership: "mcp",
    purpose: input.purpose ?? input.url,
    reusable: Boolean(input.reusable),
    protected: Boolean(input.protected),
    sticky: Boolean(input.sticky),
    createdAt: now,
    lastUsedAt: now,
    requestedUrl: input.url,
  };
  owned[String(tab.id)] = metadata;
  await writeOwnedTabs(owned);
  return { tab: toBrowserTab(metadata, refreshed) };
}

async function navigate(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  const metadata = await requireOwnedMetadata(chromeTabId);
  await chrome.tabs.update(chromeTabId, { url: input.url, active: true });
  await waitForTabComplete(chromeTabId, 30000).catch(() => undefined);
  metadata.lastUsedAt = new Date().toISOString();
  metadata.requestedUrl = input.url;
  await updateMetadata(chromeTabId, metadata);
  const tab = await chrome.tabs.get(chromeTabId);
  return { tab: toBrowserTab(metadata, tab) };
}

async function snapshot(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const generation = crypto.randomUUID().replaceAll("-", "");
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: snapshotPage,
    args: [generation],
  });
  if (!injection?.result) throw coded("BROWSER_DISCONNECTED", "The page snapshot could not be read.");
  return {
    tabId: input.tabId,
    url: injection.result.url,
    ...(injection.result.title ? { title: injection.result.title } : {}),
    content: injection.result.content,
    refs: injection.result.refs,
  };
}

async function click(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: clickRef,
    args: [input.ref],
  });
  if (!result?.result) throw coded("LOCATOR_NOT_FOUND", "The personal browser element ref was not found.");
  return { tabId: input.tabId, completed: true };
}

async function fill(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: fillRef,
    args: [input.ref, input.value],
  });
  if (!result?.result) throw coded("LOCATOR_NOT_FOUND", "The personal browser field ref was not found.");
  return { tabId: input.tabId, completed: true };
}

async function press(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: pressKey,
    args: [input.key],
  });
  return { tabId: input.tabId, completed: true };
}

async function wait(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1, Math.min(120000, input.timeoutMs)) : 30000;
  if (!input.text && !input.ref) {
    await delay(timeoutMs);
    return { tabId: input.tabId, completed: true };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: waitProbe,
      args: [input.text ?? null, input.ref ?? null],
    }).catch(() => []);
    if (result?.result) return { tabId: input.tabId, completed: true };
    await delay(200);
  }
  throw coded("STATE_NOT_REACHED", "The requested personal browser state was not reached before timeout.");
}

async function extract(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: extractPage,
    args: [input.ref ?? null, input.selector ?? null, input.format ?? "text"],
  });
  if (!result?.result?.found) throw coded("LOCATOR_NOT_FOUND", "The requested personal browser extraction target was not found.");
  return {
    tabId: input.tabId,
    format: input.format ?? "text",
    value: result.result.value,
  };
}

async function sequence(input) {
  const results = [];
  for (let index = 0; index < input.steps.length; index += 1) {
    const step = input.steps[index];
    let value;
    if (step.action === "navigate") value = await navigate({ tabId: input.tabId, url: step.url });
    else if (step.action === "click") value = await click({ tabId: input.tabId, ref: step.ref });
    else if (step.action === "fill") value = await fill({ tabId: input.tabId, ref: step.ref, value: step.value });
    else if (step.action === "press") value = await press({ tabId: input.tabId, key: step.key });
    else if (step.action === "wait") value = await wait({ tabId: input.tabId, timeoutMs: step.timeoutMs, text: step.text, ref: step.ref });
    else if (step.action === "extract") value = await extract({ tabId: input.tabId, ref: step.ref, selector: step.selector, format: step.format });
    results.push({
      index,
      action: step.action,
      completed: true,
      ...(step.action === "extract" ? { value: value.value } : {}),
    });
  }
  const response = { tabId: input.tabId, completed: true, steps: results };
  if (input.finalSnapshot) response.snapshot = await snapshot({ tabId: input.tabId });
  return response;
}

async function goBack(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  const metadata = await requireOwnedMetadata(chromeTabId);
  await chrome.tabs.goBack(chromeTabId);
  await waitForTabComplete(chromeTabId, 10000).catch(() => undefined);
  const tab = await chrome.tabs.get(chromeTabId);
  return { tab: toBrowserTab(metadata, tab) };
}

async function goForward(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  const metadata = await requireOwnedMetadata(chromeTabId);
  await chrome.tabs.goForward(chromeTabId);
  await waitForTabComplete(chromeTabId, 10000).catch(() => undefined);
  const tab = await chrome.tabs.get(chromeTabId);
  return { tab: toBrowserTab(metadata, tab) };
}

async function closeTab(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  await chrome.tabs.remove(chromeTabId).catch(() => undefined);
  const owned = await readOwnedTabs();
  delete owned[String(chromeTabId)];
  await writeOwnedTabs(owned);
  return { tabId: input.tabId, completed: true };
}

async function finishTask(input) {
  const owned = await readOwnedTabs();
  const closedTabIds = [];
  for (const [key, metadata] of Object.entries(owned)) {
    if (input.taskId && metadata.taskId !== input.taskId) continue;
    const chromeTabId = Number(key);
    await chrome.tabs.remove(chromeTabId).catch(() => undefined);
    closedTabIds.push(metadata.tabId);
    delete owned[key];
  }
  await writeOwnedTabs(owned);
  return {
    completed: true,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    closedTabs: closedTabIds.length,
    closedTabIds,
    browserClosed: false,
  };
}

async function requireOwnedMetadata(chromeTabId) {
  const owned = await readOwnedTabs();
  const metadata = owned[String(chromeTabId)];
  if (!metadata) throw coded("TAB_NOT_OWNED", "The Chrome tab is not owned by MCP V3 personal browser mode.");
  const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
  if (!tab) {
    delete owned[String(chromeTabId)];
    await writeOwnedTabs(owned);
    throw coded("TAB_NOT_FOUND", "The personal browser tab no longer exists.");
  }
  return metadata;
}

async function updateMetadata(chromeTabId, metadata) {
  const owned = await readOwnedTabs();
  owned[String(chromeTabId)] = metadata;
  await writeOwnedTabs(owned);
}

async function readOwnedTabs() {
  const value = await chrome.storage.local.get(OWNED_TABS_KEY);
  const owned = value[OWNED_TABS_KEY];
  return owned && typeof owned === "object" ? owned : {};
}

async function writeOwnedTabs(owned) {
  await chrome.storage.local.set({ [OWNED_TABS_KEY]: owned });
}

function toBrowserTab(metadata, tab) {
  return {
    ...metadata,
    ...(typeof tab.url === "string" &&
      (tab.url.startsWith("http://") || tab.url.startsWith("https://"))
      ? { url: tab.url }
      : {}),
    ...(typeof tab.title === "string" ? { title: tab.title.slice(0, 500) } : {}),
  };
}

function chromeTabIdFrom(tabId) {
  const match = /^personal:(\\d+)$/u.exec(String(tabId));
  if (!match) throw coded("STALE_TAB_ID", "Invalid personal browser tab id.");
  return Number(match[1]);
}

async function waitForTabComplete(tabId, timeoutMs) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Tab load timeout"));
    }, timeoutMs);
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function snapshotPage(generation) {
  for (const stale of document.querySelectorAll("[data-mcp-v3-ref]")) {
    stale.removeAttribute("data-mcp-v3-ref");
  }
  const selector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[contenteditable='true']",
  ].join(",");
  const refs = [];
  const elements = Array.from(document.querySelectorAll(selector)).slice(0, 2000);
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
    const ref = "p-" + generation + "-" + (refs.length + 1);
    element.setAttribute("data-mcp-v3-ref", ref);
    const role = element.getAttribute("role") || defaultRole(element);
    const name = accessibleName(element).slice(0, 500);
    refs.push({ ref, role, name });
    if (refs.length >= 1000) break;
  }
  const pageText = (document.body?.innerText || "").slice(0, 180000);
  const refText = refs.map((item) => "[" + item.ref + "] " + item.role + " " + item.name).join("\\n");
  return {
    url: location.href,
    title: document.title || "",
    content: pageText + (refText ? "\\n\\nInteractive elements:\\n" + refText : ""),
    refs,
  };

  function defaultRole(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "generic";
  }

  function accessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ? labelledBy.split(/\s+/u)
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
        .filter(Boolean)
        .join(" ")
      : "";
    const labelsText = Array.from(element.labels || [])
      .map((label) => label.innerText || label.textContent || "")
      .filter(Boolean)
      .join(" ");
    const tag = element.tagName?.toLowerCase?.() || "";
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const safeButtonValue = tag === "input" && ["button", "submit", "reset"].includes(type)
      ? String(element.value || "")
      : "";
    return element.getAttribute("aria-label") ||
      labelledByText ||
      labelsText ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      safeButtonValue ||
      element.innerText ||
      element.textContent ||
      "";
  }
}

function clickRef(ref) {
  const element = document.querySelector("[data-mcp-v3-ref='" + CSS.escape(ref) + "']");
  if (!element) return false;
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  element.click();
  return true;
}

function fillRef(ref, value) {
  const element = document.querySelector("[data-mcp-v3-ref='" + CSS.escape(ref) + "']");
  if (!element) return false;
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  if (element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
  } else if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, value);
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = value;
  } else {
    return false;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function pressKey(key) {
  const target = document.activeElement || document.body;
  const options = { key, code: key, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", options));
  target.dispatchEvent(new KeyboardEvent("keypress", options));
  target.dispatchEvent(new KeyboardEvent("keyup", options));
  if (key === "Enter" && target instanceof HTMLElement) {
    const form = target.closest("form");
    if (form instanceof HTMLFormElement) form.requestSubmit?.();
  }
  return true;
}

function waitProbe(text, ref) {
  if (typeof ref === "string" && !document.querySelector("[data-mcp-v3-ref='" + CSS.escape(ref) + "']")) return false;
  if (typeof text === "string" && !(document.body?.innerText || "").includes(text)) return false;
  return true;
}

function extractPage(ref, selector, format) {
  let target = document.body;
  if (typeof ref === "string") target = document.querySelector("[data-mcp-v3-ref='" + CSS.escape(ref) + "']");
  else if (typeof selector === "string") target = document.querySelector(selector);
  if (!target) return { found: false };
  if (format === "html") return { found: true, value: target.outerHTML || target.innerHTML || "" };
  if (format === "json") {
    return {
      found: true,
      value: {
        text: target.innerText || target.textContent || "",
        tag: target.tagName?.toLowerCase?.() || null,
      },
    };
  }
  return { found: true, value: target.innerText || target.textContent || "" };
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) send({ type: "heartbeat", at: Date.now() });
  else connect();
}, 20000);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
`;

  return { manifest, serviceWorker };
}
