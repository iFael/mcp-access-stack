import { HANDOFF_EXTENSION_VERSION, HANDOFF_POPUP_HTML, HANDOFF_POPUP_SCRIPT, HANDOFF_WORKER_SOURCE } from "./personal-browser-secret-handoff-assets.js";

export interface PersonalBrowserExtensionAssets {
  manifest: string;
  serviceWorker: string;
  popupHtml: string;
  popupScript: string;
}

export const PERSONAL_BROWSER_PROTOCOL_VERSION = 1;
export const PERSONAL_BROWSER_EXTENSION_VERSION = HANDOFF_EXTENSION_VERSION;
export const PERSONAL_BROWSER_CAPABILITIES = [
  "tabs",
  "open",
  "navigate",
  "snapshot",
  "click",
  "fill",
  "press",
  "wait",
  "extract",
  "sequence",
  "screenshot",
  "tabGroups",
  "closeTab",
  "finishTask",
] as const;

export function buildPersonalBrowserExtensionAssets(
  token: string,
  port: number,
  blockedPrivateOrigins: readonly string[] = [],
): PersonalBrowserExtensionAssets {
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: "MCP V3 Personal Browser",
    version: PERSONAL_BROWSER_EXTENSION_VERSION,
    description: "Connects explicitly MCP-owned tabs in your personal Chrome profile to MCP V3.",
    minimum_chrome_version: "116",
    permissions: ["tabs", "scripting", "storage", "debugger", "tabGroups"],
    host_permissions: ["http://*/*", "https://*/*"],
    background: { service_worker: "service-worker.js" },
    action: { default_title: "MCP V3 Personal Browser", default_popup: "secret-provision.html" },
    commands: { "fill-mcp-preparation-secret": { suggested_key: { default: "Ctrl+Shift+8" }, description: "Fill the focused MCP prepare-secret field without showing its value" } },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:" + port,
    },
  }, null, 2) + "\n";

  const serviceWorker = `"use strict";

const BRIDGE_TOKEN = ${JSON.stringify(token)};
const BRIDGE_PORT = ${port};
const BRIDGE_URL = "ws://127.0.0.1:" + BRIDGE_PORT + "/?token=" + encodeURIComponent(BRIDGE_TOKEN);
const PROTOCOL_VERSION = ${PERSONAL_BROWSER_PROTOCOL_VERSION};
const EXTENSION_VERSION = ${JSON.stringify(PERSONAL_BROWSER_EXTENSION_VERSION)};
const CAPABILITIES = ${JSON.stringify(PERSONAL_BROWSER_CAPABILITIES)};
const BLOCKED_PRIVATE_ORIGINS = new Set(${JSON.stringify(blockedPrivateOrigins)});
const PERSONAL_PREFIX = "personal:";
const OWNED_TABS_KEY = "mcpV3OwnedTabs"; // gitleaks:allow -- public storage slot identifier, not a credential
const MAX_SCREENSHOT_BASE64_CHARS = 3000000;
const MAX_FULL_PAGE_PIXELS = 40000000;
const MUTATING_OPERATIONS = new Set([
  "open",
  "navigate",
  "click",
  "fill",
  "press",
  "sequence",
  "goBack",
  "goForward",
  "closeTab",
  "finishTask",
]);

let socket;
let reconnectTimer;
let ownershipTail = Promise.resolve();
const inFlightRequests = new Map();
const mutationQueues = new Map();
const taskGroups = new Map();

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(BRIDGE_URL);
  socket.onopen = () => send({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: EXTENSION_VERSION,
    browser: "chrome",
    profile: "personal",
    capabilities: CAPABILITIES,
  });
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

function send(value, timing) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const started = performance.now();
  let raw = JSON.stringify(value);
  if (timing) {
    timing.serializationMs = performance.now() - started;
    timing.totalMs = performance.now() - timing.started;
    const safe = { receivedAt: timing.receivedAt, totalMs: timing.totalMs, queueMs: timing.queueMs,
      actionMs: timing.actionMs, snapshotMs: timing.snapshotMs, serializationMs: timing.serializationMs };
    // Append the small fixed metadata without serializing the result a second time.
    raw = raw.slice(0, -1) + ',"timing":' + JSON.stringify(safe) + '}';
  }
  socket.send(raw);
}

async function handleMessage(raw) {
  const received = performance.now();
  const receivedAt = Date.now();
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (message?.type === "cancel" && typeof message.id === "string") {
    inFlightRequests.get(message.id)?.abort("cancelled");
    return;
  }
  if (message?.type !== "request" || typeof message.id !== "string") return;

  const operation = String(message.operation);
  const timing = message.measureTiming === true ? { started: received, receivedAt, totalMs: 0, queueMs: 0, actionMs: 0, snapshotMs: 0, serializationMs: 0 } : undefined;
  const controller = new AbortController();
  inFlightRequests.set(message.id, controller);
  const deadlineMs = typeof message.deadlineAt === "string"
    ? Date.parse(message.deadlineAt) - Date.now()
    : Number.POSITIVE_INFINITY;
  let deadlineTimer;
  if (Number.isFinite(deadlineMs)) {
    if (deadlineMs <= 0) controller.abort("deadline");
    else deadlineTimer = setTimeout(() => controller.abort("deadline"), Math.min(deadlineMs, 125000));
  }

  try {
    const result = await runRequest(operation, message.input ?? {}, controller.signal, timing);
    send({ type: "response", id: message.id, ok: true, result }, timing);
  } catch (error) {
    const normalized = normalizeRequestError(operation, controller.signal, error);
    send({
      type: "response",
      id: message.id,
      ok: false,
      error: {
        code: typeof normalized?.code === "string" ? normalized.code : "INTERNAL_ERROR",
        message: normalized instanceof Error ? normalized.message : String(normalized),
      },
    }, timing);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    inFlightRequests.delete(message.id);
  }
}

async function runRequest(operation, input, signal, timing) {
  const queueKey = mutationQueueKey(operation, input);
  const queuedAt = performance.now();
  const execute = async () => {
    if (timing && queueKey) timing.queueMs = performance.now() - queuedAt;
    const started = performance.now();
    const previousSnapshot = timing?.snapshotMs ?? 0;
    try { return await perform(operation, input, signal, timing); }
    finally { if (timing) timing.actionMs += Math.max(0, performance.now() - started - (timing.snapshotMs - previousSnapshot)); }
  };
  if (!queueKey) {
    throwIfAborted(signal, operation, false);
    const result = await execute();
    throwIfAborted(signal, operation, false);
    return result;
  }

  return enqueueMutation(queueKey, async () => {
    if (timing) timing.queueMs = performance.now() - queuedAt;
    throwIfAborted(signal, operation, false);
    let started = false;
    try {
      started = true;
      const result = await execute();
      throwIfAborted(signal, operation, started);
      return result;
    } catch (error) {
      if (signal.aborted) throw cancellationError(operation, signal, started);
      throw error;
    }
  });
}

async function perform(operation, input, signal, timing) {
  switch (operation) {
    case "tabs": return tabs(input, signal);
    case "open": return open(input, signal);
    case "navigate": return navigate(input, signal);
    case "snapshot": return snapshot(input, signal);
    case "click": return click(input, signal);
    case "fill": return fill(input, signal);
    case "press": return press(input, signal);
    case "wait": return wait(input, signal);
    case "extract": return extract(input, signal);
    case "sequence": return sequence(input, signal, timing);
    case "screenshot": return screenshot(input, signal);
    case "goBack": return goBack(input, signal);
    case "goForward": return goForward(input, signal);
    case "closeTab": return closeTab(input, signal);
    case "finishTask": return finishTask(input, signal);
    default: throw coded("BROWSER_CAPABILITY_UNSUPPORTED", operation + " is not supported by personal browser mode.");
  }
}

async function tabs(input) {
  return withOwnershipLock(async () => {
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
  });
}

async function open(input, signal) {
  const targetUrl = assertPersonalNavigationTarget(input.url);

  if (input.reusable) {
    const restored = await withOwnershipLock(async () => {
      const owned = await readOwnedTabs();
      for (const [key, metadata] of Object.entries(owned)) {
        if (metadata.taskId !== input.taskId || metadata.purpose !== (input.purpose ?? targetUrl)) continue;
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
      await writeOwnedTabs(owned);
      return undefined;
    });
    if (restored) return restored;
  }

  throwIfAborted(signal, "open", false);
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  if (typeof tab.id !== "number") throw coded("INTERNAL_ERROR", "Chrome did not return a tab id.");
  try {
    await waitForTabComplete(tab.id, 30000, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const now = new Date().toISOString();
  const sticky = input.sticky === true;
  let metadata;
  let refreshed;
  try {
    refreshed = await withOwnershipLock(async () => {
      const current = await chrome.tabs.get(tab.id).catch(() => undefined);
      if (!current) throw coded("TAB_NOT_FOUND", "The personal browser tab no longer exists.");
      const owned = await readOwnedTabs();
      const mcpGroupId = typeof input.taskId === "string"
        ? await assignMcpTaskGroup(tab.id, input.taskId, owned)
        : undefined;
      metadata = {
        tabId: PERSONAL_PREFIX + tab.id,
        ...(typeof input.taskId === "string" ? { taskId: input.taskId } : {}),
        lifecycle: typeof input.taskId === "string" ? "task-scoped" : "persistent",
        ownership: "mcp",
        purpose: input.purpose ?? targetUrl,
        reusable: sticky ? false : Boolean(input.reusable),
        protected: sticky ? true : Boolean(input.protected),
        sticky,
        ...(sticky ? { lockedUrl: targetUrl } : {}),
        ...(Number.isInteger(mcpGroupId) ? { mcpGroupId } : {}),
        createdAt: now,
        lastUsedAt: now,
        requestedUrl: targetUrl,
      };
      owned[String(tab.id)] = metadata;
      await writeOwnedTabs(owned);
      return current;
    });
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
    throw error;
  }
  return { tab: toBrowserTab(metadata, refreshed) };
}

async function navigate(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  const metadata = await requireOwnedMetadata(chromeTabId);
  const targetUrl = assertPersonalNavigationTarget(input.url);
  if (metadata.sticky && metadata.lockedUrl && targetUrl !== metadata.lockedUrl) {
    throw coded("NAVIGATION_BLOCKED", "The sticky personal browser tab cannot navigate away from its locked URL.");
  }
  throwIfAborted(signal, "navigate", false);
  await chrome.tabs.update(chromeTabId, { url: targetUrl, active: true });
  try {
    await waitForTabComplete(chromeTabId, 30000, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  metadata.lastUsedAt = new Date().toISOString();
  metadata.requestedUrl = targetUrl;
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

async function wait(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1, Math.min(120000, input.timeoutMs)) : 30000;
  if (!input.text && !input.ref) {
    await delay(timeoutMs, signal);
    return { tabId: input.tabId, completed: true };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal, "wait", false);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: waitProbe,
      args: [input.text ?? null, input.ref ?? null],
    }).catch(() => []);
    if (result?.result) return { tabId: input.tabId, completed: true };
    await delay(200, signal);
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

async function sequence(input, signal, timing) {
  const results = [];
  for (let index = 0; index < input.steps.length; index += 1) {
    throwIfAborted(signal, "sequence", true);
    const step = input.steps[index];
    let value;
    if (step.action === "navigate") value = await navigate({ tabId: input.tabId, url: step.url }, signal);
    else if (step.action === "click") value = await click({ tabId: input.tabId, ref: step.ref }, signal);
    else if (step.action === "fill") value = await fill({ tabId: input.tabId, ref: step.ref, value: step.value }, signal);
    else if (step.action === "press") value = await press({ tabId: input.tabId, key: step.key }, signal);
    else if (step.action === "wait") value = await wait({ tabId: input.tabId, timeoutMs: step.timeoutMs, text: step.text, ref: step.ref }, signal);
    else if (step.action === "extract") value = await extract({ tabId: input.tabId, ref: step.ref, selector: step.selector, format: step.format }, signal);
    results.push({
      index,
      action: step.action,
      completed: true,
      ...(step.action === "extract" ? { value: value.value } : {}),
    });
  }
  const response = { tabId: input.tabId, completed: true, steps: results };
  if (input.finalSnapshot) {
    const started = performance.now();
    try { response.snapshot = await snapshot({ tabId: input.tabId }, signal); }
    finally { if (timing) timing.snapshotMs += performance.now() - started; }
  }
  return response;
}

async function screenshot(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "screenshot", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");
    let clip;
    if (input.fullPage === true) {
      const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
      const contentSize = metrics?.cssContentSize ?? metrics?.contentSize;
      const width = Math.ceil(Number(contentSize?.width));
      const height = Math.ceil(Number(contentSize?.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome did not expose full-page layout metrics.");
      }
      if (width * height > MAX_FULL_PAGE_PIXELS) {
        throw coded("LIMIT_EXCEEDED", "The personal browser page is too large for a bounded full-page screenshot.");
      }
      clip = { x: 0, y: 0, width, height, scale: 1 };
    }

    let data = "";
    for (const quality of [80, 65, 50]) {
      throwIfAborted(signal, "screenshot", false);
      const captured = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "jpeg",
        quality,
        fromSurface: true,
        captureBeyondViewport: input.fullPage === true,
        ...(clip ? { clip } : {}),
      });
      data = typeof captured?.data === "string" ? captured.data : "";
      if (data && data.length <= MAX_SCREENSHOT_BASE64_CHARS) break;
    }
    if (!data) throw coded("BROWSER_DISCONNECTED", "Chrome returned no screenshot data.");
    if (data.length > MAX_SCREENSHOT_BASE64_CHARS) {
      throw coded("LIMIT_EXCEEDED", "The personal browser screenshot exceeds the bounded MCP payload budget.");
    }
    throwIfAborted(signal, "screenshot", false);
    return {
      tabId: input.tabId,
      path: "personal://screenshot/" + crypto.randomUUID() + ".jpg",
      sizeBytes: base64ByteLength(data),
      mimeType: "image/jpeg",
      contentBase64: data,
    };
  } catch (error) {
    if (signal?.aborted) throw cancellationError("screenshot", signal, false);
    if (error && typeof error.code === "string") throw error;
    throw coded(
      "BROWSER_CAPABILITY_UNSUPPORTED",
      "Personal browser screenshot requires Chrome debugger access for the MCP-owned tab.",
    );
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined);
  }
}

function base64ByteLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

async function goBack(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  const metadata = await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "goBack", false);
  await chrome.tabs.goBack(chromeTabId);
  try {
    await waitForTabComplete(chromeTabId, 10000, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const tab = await chrome.tabs.get(chromeTabId);
  return { tab: toBrowserTab(metadata, tab) };
}

async function goForward(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  const metadata = await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "goForward", false);
  await chrome.tabs.goForward(chromeTabId);
  try {
    await waitForTabComplete(chromeTabId, 10000, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const tab = await chrome.tabs.get(chromeTabId);
  return { tab: toBrowserTab(metadata, tab) };
}

async function closeTab(input) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  const metadata = await requireOwnedMetadata(chromeTabId);
  if (metadata.protected || metadata.sticky) {
    throw coded("TAB_PROTECTED", "The personal browser tab is protected and cannot be closed directly.");
  }
  await chrome.tabs.remove(chromeTabId).catch(() => undefined);
  await removeOwnedTab(chromeTabId);
  return { tabId: input.tabId, completed: true };
}

async function finishTask(input) {
  const targets = await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    return Object.entries(owned)
      .filter(([, metadata]) => !input.taskId || metadata.taskId === input.taskId)
      .map(([key, metadata]) => ({
        chromeTabId: Number(key),
        tabId: metadata.tabId,
        mcpGroupId: metadata.mcpGroupId,
      }));
  });

  if (input.keepOpen === true) {
    const groupedTabIds = [];
    for (const target of targets) {
      const current = await chrome.tabs.get(target.chromeTabId).catch(() => undefined);
      if (current && Number.isInteger(target.mcpGroupId) && current.groupId === target.mcpGroupId) {
        groupedTabIds.push(target.chromeTabId);
      }
    }
    if (groupedTabIds.length > 0) await chrome.tabs.ungroup(groupedTabIds);
    await withOwnershipLock(async () => {
      const owned = await readOwnedTabs();
      for (const target of targets) delete owned[String(target.chromeTabId)];
      await writeOwnedTabs(owned);
    });
    if (typeof input.taskId === "string") taskGroups.delete(input.taskId);
    return {
      completed: true,
      taskId: input.taskId,
      closedTabs: 0,
      closedTabIds: [],
      releasedTabs: targets.length,
      releasedTabIds: targets.map((target) => target.tabId),
      browserClosed: false,
    };
  }

  for (const target of targets) {
    await chrome.tabs.remove(target.chromeTabId).catch(() => undefined);
  }
  await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    for (const target of targets) delete owned[String(target.chromeTabId)];
    await writeOwnedTabs(owned);
  });
  if (typeof input.taskId === "string") taskGroups.delete(input.taskId);
  return {
    completed: true,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    closedTabs: targets.length,
    closedTabIds: targets.map((target) => target.tabId),
    browserClosed: false,
  };
}

async function assignMcpTaskGroup(chromeTabId, taskId, owned) {
  const persistedGroupId = Object.values(owned || {})
    .find((metadata) => metadata?.taskId === taskId && Number.isInteger(metadata?.mcpGroupId))
    ?.mcpGroupId;
  const existingGroupId = taskGroups.get(taskId) ?? persistedGroupId;
  if (Number.isInteger(existingGroupId)) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: chromeTabId, groupId: existingGroupId });
      taskGroups.set(taskId, groupId);
      return groupId;
    } catch {
      taskGroups.delete(taskId);
    }
  }
  const groupId = await chrome.tabs.group({ tabIds: chromeTabId });
  await chrome.tabGroups.update(groupId, { title: "MCP" });
  taskGroups.set(taskId, groupId);
  return groupId;
}

async function requireOwnedMetadata(chromeTabId) {
  return withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    const metadata = owned[String(chromeTabId)];
    if (!metadata) throw coded("TAB_NOT_OWNED", "The Chrome tab is not owned by MCP V3 personal browser mode.");
    const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
    if (!tab) {
      delete owned[String(chromeTabId)];
      await writeOwnedTabs(owned);
      throw coded("TAB_NOT_FOUND", "The personal browser tab no longer exists.");
    }
    return { ...metadata };
  });
}

async function updateMetadata(chromeTabId, metadata) {
  await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    if (!owned[String(chromeTabId)]) {
      throw coded("TAB_NOT_OWNED", "The Chrome tab is not owned by MCP V3 personal browser mode.");
    }
    owned[String(chromeTabId)] = metadata;
    await writeOwnedTabs(owned);
  });
}

async function removeOwnedTab(chromeTabId) {
  await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    if (!owned[String(chromeTabId)]) return;
    delete owned[String(chromeTabId)];
    await writeOwnedTabs(owned);
  });
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
  const { mcpGroupId: _mcpGroupId, lockedUrl: _lockedUrl, ...publicMetadata } = metadata;
  return {
    ...publicMetadata,
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

async function waitForTabComplete(tabId, timeoutMs, signal) {
  throwIfAborted(signal, "navigation", false);
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      signal?.removeEventListener("abort", onAbort);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Tab load timeout"));
    }, timeoutMs);
    const onAbort = () => {
      cleanup();
      reject(cancellationError("navigation", signal, true));
    };
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      cleanup();
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
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
    "summary",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[role='listbox']",
    "[role='option']",
    "[role='menuitem']",
    "[role='tab']",
    "[role='switch']",
    "[role='slider']",
    "[role='spinbutton']",
    "[contenteditable='true']",
  ].join(",");
  const refs = [];
  const refLines = [];
  const elements = Array.from(document.querySelectorAll(selector)).slice(0, 2000);
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
    const ref = "p-" + generation + "-" + (refs.length + 1);
    element.setAttribute("data-mcp-v3-ref", ref);
    const role = element.getAttribute("role") || defaultRole(element);
    const name = normalizeText(accessibleName(element)).slice(0, 500);
    const states = semanticStates(element, role);
    refs.push({ ref, role, name });
    refLines.push(
      "- " + role +
      (name ? " " + JSON.stringify(name) : "") +
      (states.length ? " " + states.map((state) => "[" + state + "]").join(" ") : "") +
      " [ref=" + ref + "]",
    );
    if (refs.length >= 1000) break;
  }
  const pageText = (document.body?.innerText || "").slice(0, 180000);
  const refText = refLines.join("\\n");
  return {
    url: location.href,
    title: document.title || "",
    content: pageText + (refText ? "\\n\\nInteractive elements:\\n" + refText : ""),
    refs,
  };

  function defaultRole(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return element.multiple ? "listbox" : "combobox";
    if (tag === "input") {
      const type = String(element.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image", "file"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    return "generic";
  }

  function semanticStates(element, role) {
    const states = [];
    if (element.disabled === true || element.getAttribute("aria-disabled") === "true") states.push("disabled");
    if (element.required === true || element.getAttribute("aria-required") === "true") states.push("required");
    if (["checkbox", "radio", "switch"].includes(role)) {
      const ariaChecked = element.getAttribute("aria-checked");
      const checked = typeof element.checked === "boolean"
        ? element.checked
        : ariaChecked === "true"
          ? true
          : ariaChecked === "false"
            ? false
            : undefined;
      if (checked !== undefined) states.push(checked ? "checked" : "unchecked");
    }
    if (role === "option") {
      const ariaSelected = element.getAttribute("aria-selected");
      const selected = typeof element.selected === "boolean"
        ? element.selected
        : ariaSelected === "true"
          ? true
          : ariaSelected === "false"
            ? false
            : undefined;
      if (selected !== undefined) states.push(selected ? "selected" : "unselected");
    }
    const expanded = element.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") states.push("expanded=" + expanded);
    const pressed = element.getAttribute("aria-pressed");
    if (pressed === "true" || pressed === "false" || pressed === "mixed") states.push("pressed=" + pressed);
    return states;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\\s+/gu, " ").trim();
  }

  function accessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ? labelledBy.split(/\\s+/u)
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

function assertPersonalNavigationTarget(rawUrl) {
  if (typeof rawUrl !== "string") {
    throw coded("INVALID_ARGUMENT", "Personal browser mode requires an explicit http(s) URL.");
  }
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw coded("INVALID_ARGUMENT", "Personal browser mode requires a valid http(s) URL.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw coded("NAVIGATION_BLOCKED", "Personal browser mode only permits http(s) navigation.");
  }
  if (target.username || target.password) {
    throw coded("NAVIGATION_BLOCKED", "Credentials embedded in browser URLs are not permitted.");
  }
  if (BLOCKED_PRIVATE_ORIGINS.has(target.origin) || isPrivateHost(target.hostname)) {
    throw coded(
      "NAVIGATION_BLOCKED",
      "Personal browser mode blocks private or local network targets; use browser_open_authorized_site in managed mode.",
    );
  }
  return target.href;
}

function isPrivateHost(rawHost) {
  const host = String(rawHost || "").toLowerCase().replace(/^\\[|\\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.startsWith("::ffff:")) return isPrivateIpv4(host.slice(7));
  if (host.includes(":")) {
    return host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/u.test(host);
  }
  return isPrivateIpv4(host);
}

function isPrivateIpv4(host) {
  if (!/^\\d{1,3}(?:\\.\\d{1,3}){3}$/u.test(host)) return false;
  const parts = host.split(".").map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mutationQueueKey(operation, input) {
  if (!MUTATING_OPERATIONS.has(operation)) return null;
  if (typeof input?.tabId === "string") return "tab:" + input.tabId;
  if (operation === "open" && typeof input?.taskId === "string") return "task:" + input.taskId;
  if (operation === "finishTask" && typeof input?.taskId === "string") return "task:" + input.taskId;
  return "operation:" + operation;
}

function enqueueMutation(key, work) {
  const previous = mutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  const tail = current.then(() => undefined, () => undefined);
  mutationQueues.set(key, tail);
  void tail.finally(() => {
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
  });
  return current;
}

function withOwnershipLock(work) {
  const current = ownershipTail.catch(() => undefined).then(work);
  ownershipTail = current.then(() => undefined, () => undefined);
  return current;
}

function cancellationError(operation, signal, started) {
  if (started && MUTATING_OPERATIONS.has(operation)) {
    return coded(
      "EXECUTION_OUTCOME_UNKNOWN",
      "Personal browser mutation outcome is unknown after cancellation: " + operation,
    );
  }
  if (signal?.reason === "deadline") {
    return coded("BROWSER_WORKER_TIMEOUT", "Personal browser operation deadline elapsed: " + operation);
  }
  return coded("OPERATION_CANCELLED", "Personal browser operation was cancelled: " + operation);
}

function normalizeRequestError(operation, signal, error) {
  if (error && typeof error.code === "string") return error;
  if (!signal.aborted) return error;
  return cancellationError(operation, signal, false);
}

function throwIfAborted(signal, operation, started) {
  if (signal?.aborted) throw cancellationError(operation, signal, started);
}

function delay(ms, signal) {
  throwIfAborted(signal, "wait", false);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(cancellationError("wait", signal, false));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

${HANDOFF_WORKER_SOURCE}

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeOwnedTab(tabId);
});

setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) send({ type: "heartbeat", at: Date.now() });
  else connect();
}, 20000);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
`;

  return { manifest, serviceWorker, popupHtml: HANDOFF_POPUP_HTML, popupScript: HANDOFF_POPUP_SCRIPT };
}
