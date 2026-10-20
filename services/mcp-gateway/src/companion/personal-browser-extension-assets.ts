import { HANDOFF_EXTENSION_VERSION, HANDOFF_POPUP_HTML, HANDOFF_POPUP_SCRIPT, HANDOFF_WORKER_SOURCE } from "./personal-browser-secret-handoff-assets.js";
import { summarizeCdpAccessibility } from "./personal-browser-accessibility.js";

export interface PersonalBrowserExtensionAssets {
  manifest: string;
  serviceWorker: string;
  popupHtml: string;
  popupScript: string;
}

export function sanitizePersonalDiagnosticText(value: string, maxChars = 8_000): string {
  return value.slice(0, maxChars)
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/((?:x-)?api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/([?&](?:access_?token|token|api_?key|secret|session|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/("(?:access_?token|token|apiKey|api_key|secret|password|cookie|authorization)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/((?:access_?token|token|api_?key|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}

export const PERSONAL_BROWSER_PROTOCOL_VERSION = 1;
export const PERSONAL_BROWSER_EXTENSION_VERSION = HANDOFF_EXTENSION_VERSION;
export const PERSONAL_BROWSER_REQUIRED_CAPABILITIES = [
  "tabs", "open", "navigate", "snapshot", "click", "fill", "press", "closeTab", "finishTask",
] as const;

export const PERSONAL_BROWSER_MUTATING_OPERATIONS = [
  "open", "selectTab", "dialog", "viewport", "upload", "download", "navigate", "snapshot", "screenshot", "console", "networkList", "pdf",
  "evaluate", "click", "hover", "drag", "scroll", "fill", "formInput", "type", "press", "sequence",
  "goBack", "goForward", "closeTab", "finishTask",
] as const;

export const PERSONAL_BROWSER_CAPABILITIES = [
  "tabs",
  "selectTab",
  "dialog",
  "viewport",
  "upload",
  "download",
  "open",
  "navigate",
  "snapshot",
  "evaluate",
  "click",
  "hover",
  "drag",
  "scroll",
  "fill",
  "formInput",
  "type",
  "press",
  "wait",
  "extract",
  "sequence",
  "screenshot",
  "console",
  "networkList",
  "networkInspect",
  "pdf",
  "goBack",
  "goForward",
  "tabGroups",
  "guardedActionsV1",
  "snapshotRevisionV1",
  "openShadowDomV1",
  "cdpAccessibilityV1",
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
    permissions: ["tabs", "scripting", "storage", "debugger", "downloads", "tabGroups"],
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
const summarizeCdpAccessibility = (${summarizeCdpAccessibility.toString()});
const sanitizePersonalDiagnosticText = (${sanitizePersonalDiagnosticText.toString()});
const BLOCKED_PRIVATE_ORIGINS = new Set(${JSON.stringify(blockedPrivateOrigins)});
const PERSONAL_PREFIX = "personal:";
const OWNED_TABS_KEY = "mcpV3OwnedTabs"; // gitleaks:allow -- public storage slot identifier, not a credential
const MAX_SCREENSHOT_BASE64_CHARS = 3000000;
const MAX_FULL_PAGE_PIXELS = 40000000;
const MUTATING_OPERATIONS = new Set(${JSON.stringify(PERSONAL_BROWSER_MUTATING_OPERATIONS)});

let socket;
let reconnectTimer;
let ownershipTail = Promise.resolve();
const inFlightRequests = new Map();
const mutationQueues = new Map();
const taskGroups = new Map();
const axTargetsByTab = new Map();
const personalConsoleEntries = new Map();
const personalNetworkEntries = new Map();
const personalNetworkCaptures = new Map();
const personalDialogArms = new Map();
const personalViewportSessions = new Map();
globalThis.__mcpV3PersonalViewportSessions = personalViewportSessions;
globalThis.__mcpV3PersonalDialogArms = personalDialogArms;
function borrowPersonalDebugger(target) {
  const key = String(target.tabId);
  const viewport = globalThis.__mcpV3PersonalViewportSessions?.get(key);
  if (viewport) {
    viewport.borrowers += 1;
    return viewport;
  }
  const dialog = globalThis.__mcpV3PersonalDialogArms?.get(key);
  if (dialog && !dialog.closing) {
    dialog.borrowers += 1;
    return dialog;
  }
  const session = globalThis.__mcpV3PersonalNetworkCaptures?.get(key);
  if (!session) return null;
  session.borrowers = (session.borrowers ?? 0) + 1;
  return session;
}

async function attachGuardedDebugger(target) {
  if (borrowPersonalDebugger(target)) return false;
  await chrome.debugger.attach(target, "1.3");
  return true;
}

async function detachGuardedDebugger(target, attached) {
  if (attached) {
    await chrome.debugger.detach(target);
    return;
  }
  const key = String(target.tabId);
  const viewport = globalThis.__mcpV3PersonalViewportSessions?.get(key);
  if (viewport && viewport.borrowers > 0) {
    viewport.borrowers -= 1;
    return;
  }
  const dialog = globalThis.__mcpV3PersonalDialogArms?.get(key);
  if (dialog && dialog.borrowers > 0) {
    dialog.borrowers -= 1;
    if (dialog.closing && dialog.borrowers === 0) {
      globalThis.__mcpV3PersonalDialogArms?.delete(key);
      if (dialog.attached) await chrome.debugger.detach(target).catch(() => undefined);
      else {
        const network = globalThis.__mcpV3PersonalNetworkCaptures?.get(key);
        if (network) network.borrowers = Math.max(0, (network.borrowers ?? 0) - 1);
      }
    }
    return;
  }
  const borrowed = globalThis.__mcpV3PersonalNetworkCaptures?.get(key);
  if (borrowed) borrowed.borrowers = Math.max(0, (borrowed.borrowers ?? 0) - 1);
}



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
    case "selectTab": return selectOwnedTab(input, signal);
    case "dialog": return observePersonalDialog(input, signal);
    case "viewport": return configurePersonalViewport(input, signal);
    case "upload": return uploadPersonalFiles(input, signal);
    case "download": return downloadPersonalFile(input, signal);
    case "open": return open(input, signal);
    case "navigate": return navigate(input, signal);
    case "snapshot": return snapshot(input, signal);
    case "evaluate": return evaluatePage(input, signal);
    case "click": return click(input, signal);
    case "hover": return hover(input, signal);
    case "drag": return drag(input, signal);
    case "scroll": return scroll(input, signal);
    case "fill": return fill(input, signal);
    case "formInput": return formInput(input, signal);
    case "type": return typeText(input, signal);
    case "press": return press(input, signal);
    case "wait": return wait(input, signal);
    case "extract": return extract(input, signal);
    case "sequence": return sequence(input, signal, timing);
    case "screenshot": return screenshot(input, signal);
    case "console": return readPersonalConsole(input, signal);
    case "networkList": return readPersonalNetwork(input, signal);
    case "networkInspect": return inspectPersonalNetwork(input, signal);
    case "pdf": return printPersonalPdf(input, signal);
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

async function finalizePersonalDialog(chromeTabId, dismiss) {
  const key = String(chromeTabId);
  const session = personalDialogArms.get(key);
  if (!session || session.closing) return;
  session.closing = true;
  clearTimeout(session.timer);
  chrome.debugger.onEvent.removeListener(session.listener);
  if (dismiss && session.open) {
    await chrome.debugger.sendCommand({ tabId: chromeTabId }, "Page.handleJavaScriptDialog", {
      accept: false,
    }).catch(() => undefined);
  }
  if (session.borrowers > 0) return;
  personalDialogArms.delete(key);
  if (session.attached) {
    await chrome.debugger.detach({ tabId: chromeTabId }).catch(() => undefined);
  } else {
    await detachGuardedDebugger({ tabId: chromeTabId }, false).catch(() => undefined);
  }
}

async function observePersonalDialog(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "dialog", false);
  const key = String(chromeTabId);
  const current = personalDialogArms.get(key);
  const describe = (session) => ({
    tabId: input.tabId,
    state: !session || session.closing ? "idle" : session.open ? "open" : "armed",
    ...(session?.open ? { dialogType: session.open.type, message: session.open.message } : {}),
    ...(session && !session.closing ? { expiresAt: session.expiresAt } : {}),
  });
  if (input.action === "inspect") return describe(current);
  if (input.action === "cancel") {
    await finalizePersonalDialog(chromeTabId, true);
    return describe(undefined);
  }
  if (input.action === "respond") {
    if (!current || current.closing || !current.open ||
        typeof input.expectedMessage !== "string" ||
        current.open.message !== input.expectedMessage) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "Dialog is absent or its inspected message changed.");
    }
    if (input.promptText !== undefined && current.open.type !== "prompt") {
      throw coded("INVALID_ARGUMENT", "Prompt text requires a JavaScript prompt dialog.");
    }
    if (!["accept", "dismiss"].includes(input.response)) {
      throw coded("INVALID_ARGUMENT", "A dialog response must be accept or dismiss.");
    }
    const tab = await chrome.tabs.get(chromeTabId);
    if (current.url !== tab.url) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "The dialog page changed since arming.");
    }
    let responded = false;
    try {
      await chrome.debugger.sendCommand({ tabId: chromeTabId }, "Page.handleJavaScriptDialog", {
        accept: input.response === "accept",
        ...(input.response === "accept" && current.open.type === "prompt"
          ? { promptText: input.promptText ?? "" } : {}),
      });
      responded = true;
    } finally {
      await finalizePersonalDialog(chromeTabId, !responded);
    }
    return describe(undefined);
  }
  if (input.action !== "arm") throw coded("INVALID_ARGUMENT", "Unknown dialog action.");
  if (current) throw coded("EXECUTION_STATE_INVALID", "A dialog observer is already armed on this tab.");
  if (!chrome.debugger?.onEvent?.addListener || !chrome.debugger?.onEvent?.removeListener) {
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger dialog events are unavailable.");
  }
  const target = { tabId: chromeTabId };
  const tab = await chrome.tabs.get(chromeTabId);
  let attached = false;
  let listener;
  let timer;
  try {
    attached = await attachGuardedDebugger(target);
    listener = (source, method, params) => {
      if (source?.tabId !== chromeTabId || method !== "Page.javascriptDialogOpening") return;
      const dialogType = String(params?.type ?? "");
      const message = String(params?.message ?? "");
      const session = personalDialogArms.get(key);
      if (!session || session.closing) return;
      if (!["alert", "confirm", "prompt", "beforeunload"].includes(dialogType) ||
          message.length > 2000) {
        void finalizePersonalDialog(chromeTabId, true);
        return;
      }
      session.open = { type: dialogType, message };
    };
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const session = { attached, url: tab.url, listener, expiresAt, open: undefined,
      borrowers: 0, closing: false, timer: undefined };
    personalDialogArms.set(key, session);
    chrome.debugger.onEvent.addListener(listener);
    await chrome.debugger.sendCommand(target, "Page.enable");
    timer = setTimeout(() => { void finalizePersonalDialog(chromeTabId, true); }, 30_000);
    session.timer = timer;
    return describe(session);
  } catch (error) {
    if (timer) clearTimeout(timer);
    personalDialogArms.delete(key);
    if (listener) chrome.debugger.onEvent.removeListener(listener);
    await detachGuardedDebugger(target, attached).catch(() => undefined);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome could not arm its JavaScript dialog observer.");
  }
}

async function resetPersonalViewport(chromeTabId, tabId = "personal:" + chromeTabId) {
  const key = String(chromeTabId);
  const session = personalViewportSessions.get(key);
  if (!session) {
    const tab = await chrome.tabs.get(chromeTabId);
    const baseline = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId }, func: () => ({
        userAgent: navigator.userAgent, dpr: window.devicePixelRatio || 1,
        colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      }),
    }).catch(() => []);
    return { tabId, width: tab.width || 1366, height: tab.height || 768,
      deviceScaleFactor: baseline[0]?.result?.dpr || 1,
      userAgent: String(baseline[0]?.result?.userAgent ?? "").slice(0, 512),
      mobile: false, touch: false,
      colorScheme: baseline[0]?.result?.colorScheme ?? "no-preference", emulated: false };
  }
  if (session.borrowers > 0) {
    throw coded("EXECUTION_STATE_INVALID", "Viewport is still in use by another Chrome debugger operation.");
  }
  const target = { tabId: chromeTabId };
  try {
    await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride");
    await chrome.debugger.sendCommand(target, "Emulation.setTouchEmulationEnabled", { enabled: false });
    await chrome.debugger.sendCommand(target, "Emulation.setEmulatedMedia", { media: "", features: [] });
    await chrome.debugger.sendCommand(target, "Emulation.setUserAgentOverride", {
      userAgent: session.original.userAgent, platform: session.original.platform,
    });
  } finally {
    personalViewportSessions.delete(key);
    await detachGuardedDebugger(target, session.attached).catch(() => undefined);
  }
  return { tabId, ...session.original, mobile: false, touch: false,
    colorScheme: session.original.colorScheme, emulated: false };
}

async function configurePersonalViewport(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "viewport", false);
  if (input.preset === "reset") return resetPersonalViewport(chromeTabId, input.tabId);
  const profiles = {
    desktop: { width: 1366, height: 768, dpr: 1, mobile: false, touch: false },
    tablet: { width: 768, height: 1024, dpr: 2, mobile: true, touch: true },
    mobile: { width: 375, height: 812, dpr: 3, mobile: true, touch: true },
    custom: { width: input.width ?? 1280, height: input.height ?? 720,
      dpr: 1, mobile: false, touch: false },
  };
  const profile = profiles[input.preset];
  if (!profile) throw coded("INVALID_ARGUMENT", "Unknown viewport preset.");
  const width = profile.width;
  const height = profile.height;
  const deviceScaleFactor = input.deviceScaleFactor ?? profile.dpr;
  const mobile = profile.mobile;
  const touch = input.touch ?? profile.touch;
  const colorScheme = input.colorScheme ?? "no-preference";
  const key = String(chromeTabId);
  const target = { tabId: chromeTabId };
  let session = personalViewportSessions.get(key);
  const created = !session;
  let attached = false;
  try {
    if (!session) {
      const tab = await chrome.tabs.get(chromeTabId);
      attached = await attachGuardedDebugger(target);
      const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
      const evaluation = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: "({ dpr: window.devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches, ua: navigator.userAgent, platform: navigator.platform })",
        returnByValue: true,
      });
      const original = {
        width: Math.max(1, Math.round(metrics?.cssVisualViewport?.clientWidth ?? tab.width ?? 1366)),
        height: Math.max(1, Math.round(metrics?.cssVisualViewport?.clientHeight ?? tab.height ?? 768)),
        deviceScaleFactor: Math.max(0.1, Number(evaluation?.result?.value?.dpr) || 1),
        colorScheme: evaluation?.result?.value?.dark ? "dark" : "light",
        userAgent: String(evaluation?.result?.value?.ua ?? "").slice(0, 512),
        platform: String(evaluation?.result?.value?.platform ?? "").slice(0, 100),
      };
      session = { attached, original, borrowers: 0 };
      personalViewportSessions.set(key, session);
    }
    const chromeVersion = /Chrome\\/([\\d.]+)/u.exec(session.original.userAgent)?.[1];
    const mobileUA = chromeVersion && (input.preset === "mobile" || input.preset === "tablet")
      ? "Mozilla/5.0 (Linux; Android 14; " +
        (input.preset === "mobile" ? "Pixel 7" : "Pixel Tablet") +
        ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVersion +
        (input.preset === "mobile" ? " Mobile " : " ") + "Safari/537.36"
      : session.original.userAgent;
    const userAgent = input.userAgent ?? mobileUA;
    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor, mobile, screenWidth: width, screenHeight: height,
    });
    await chrome.debugger.sendCommand(target, "Emulation.setTouchEmulationEnabled", {
      enabled: touch, maxTouchPoints: touch ? 5 : 1,
    });
    await chrome.debugger.sendCommand(target, "Emulation.setEmulatedMedia", {
      media: "screen", features: [{ name: "prefers-color-scheme", value: colorScheme }],
    });
    await chrome.debugger.sendCommand(target, "Emulation.setUserAgentOverride", {
      userAgent, platform: mobile ? "Android" : session.original.platform,
    });
    throwIfAborted(signal, "viewport", true);
    return { tabId: input.tabId, width, height, deviceScaleFactor, mobile, touch,
      colorScheme, userAgent, emulated: true };
  } catch (error) {
    if (created && session) {
      await resetPersonalViewport(chromeTabId, input.tabId).catch(() => undefined);
    } else if (created && attached) {
      await chrome.debugger.detach(target).catch(() => undefined);
    }
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome viewport emulation is unavailable.");
  }
}

async function selectOwnedTab(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "selectTab", false);
  const selected = await chrome.tabs.update(chromeTabId, { active: true });
  const metadata = await requireOwnedMetadata(chromeTabId);
  return { tab: toBrowserTab(metadata, selected) };
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
  axTargetsByTab.delete(chromeTabId);
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

async function snapshot(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "snapshot", false);
  const generation = crypto.randomUUID().replaceAll("-", "");
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: snapshotPage,
    args: [generation],
  });
  if (!injection?.result) throw coded("BROWSER_DISCONNECTED", "The page snapshot could not be read.");
  let pointTarget;
  if (input.point) {
    const [target] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId }, func: inspectPointInDocument,
      args: [input.point.x, input.point.y],
    });
    pointTarget = target?.result;
    if (!pointTarget) throw coded("LOCATOR_NOT_FOUND", "No observed interactive control at those viewport coordinates.");
  }
  axTargetsByTab.delete(chromeTabId);
  const native = input.includeAccessibility
    ? await readNativeAccessibility(chromeTabId, injection.result.url, injection.result.pageInstanceId, signal)
    : undefined;
  const nativeRefs = native?.refs ?? [];
  return {
    tabId: input.tabId,
    url: injection.result.url,
    ...(injection.result.title ? { title: injection.result.title } : {}),
    ...(injection.result.pageInstanceId ? { pageInstanceId: injection.result.pageInstanceId } : {}),
    content: injection.result.content + (nativeRefs.length
      ? "\\n\\nNative accessibility controls:\\n" +
        nativeRefs.map((r) => "- " + r.role + " " + JSON.stringify(r.name) + " [ref=" + r.ref + "]").join("\\n")
      : ""),
    refs: [...injection.result.refs, ...nativeRefs],
    ...(pointTarget ? { pointTarget } : {}),
    ...(native ? { accessibility: native.summary } : {}),
  };
}

/**
 * Native AX observation returns bounded semantic data and privately bound main-frame refs.
 * OOPIF AX targets remain unavailable until session-qualified action routing is implemented.
 */
async function readNativeAccessibility(chromeTabId, expectedUrl, pageInstanceId, signal) {
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    throwIfAborted(signal, "snapshot", false);
    attached = await attachGuardedDebugger(target);
    await chrome.debugger.sendCommand(target, "Accessibility.enable");
    throwIfAborted(signal, "snapshot", false);
    const tree = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree");
    const frames = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
    const result = summarizeCdpAccessibility(tree, frames);
    const refs = [];
    const targets = new Map();
    const roles = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem", "tab", "switch", "slider", "spinbutton"]);
    for (const node of (Array.isArray(tree?.nodes) ? tree.nodes : []).slice(0, 1500)) {
      const role = node?.role?.value;
      const name = node?.name?.value;
      const backendDOMNodeId = node?.backendDOMNodeId;
      if (node.ignored || !roles.has(role) || !Number.isInteger(backendDOMNodeId) ||
          backendDOMNodeId < 1 || typeof name !== "string") continue;
      if (refs.length >= 500) break;
      const ref = "ax-" + crypto.randomUUID().replaceAll("-", "") + "-" + (refs.length + 1);
      const normalized = name.replace(/\\s+/gu, " ").trim().slice(0, 500);
      targets.set(ref, { backendDOMNodeId, role, name: normalized });
      refs.push({ ref, role, name: normalized });
    }
    const current = await chrome.tabs.get(chromeTabId);
    if (!current || current.url !== expectedUrl) {
      throw coded("BROWSER_DISCONNECTED", "Chrome navigated during accessibility observation; capture a fresh snapshot.");
    }
    throwIfAborted(signal, "snapshot", false);
    if (pageInstanceId) {
      axTargetsByTab.set(chromeTabId, {
        url: expectedUrl, pageInstanceId, targets,
      });
    }
    return { summary: result, refs: pageInstanceId ? refs : [] };
  } catch (error) {
    if (signal?.aborted) throw cancellationError("snapshot", signal, false);
    if (error && typeof error.code === "string") throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Native Chrome accessibility requires available debugger access on this MCP-owned tab.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function evaluatePage(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const current = await chrome.tabs.get(chromeTabId);
  if (!input.guard || input.guard.url !== current.url || input.ref) {
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome page evaluation requires a current page guard and no ref.");
  }
  throwIfAborted(signal, "evaluate", false);
  const source = String(input.function || "").trim();
  if (!/^(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)/u.test(source)) {
    throw coded("INVALID_ARGUMENT", "Evaluation must contain a JavaScript function expression.");
  }
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    const output = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: "(" + source + ")()",
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
      timeout: 10000,
    });
    if (output?.exceptionDetails || !output?.result || output.result.subtype === "undefined") {
      throw coded("INVALID_ARGUMENT", "Chrome evaluation did not return serializable JSON.");
    }
    const value = output?.result?.value ?? null;
    if (JSON.stringify(value).length > 262144) {
      throw coded("LIMIT_EXCEEDED", "Chrome evaluation exceeded 256 KiB.");
    }
    return { tabId: input.tabId, value };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable or occupied by DevTools.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function resolveGuardedAxPoint(chromeTabId, ref, guard, target, focus) {
  const record = axTargetsByTab.get(chromeTabId);
  const bound = record?.targets.get(ref);
  const tab = await chrome.tabs.get(chromeTabId);
  if (!record || !bound || !guard || guard.url !== record.url ||
      tab.url !== record.url || guard.ref !== ref ||
      guard.role !== bound.role || guard.name !== bound.name) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The native accessibility reference is stale or not authorized.");
  }
  const [page] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: () => globalThis.__mcpV3PageInstanceId ?? null,
  });
  if (page?.result !== record.pageInstanceId) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The Chrome document changed since the accessibility snapshot.");
  }
  if (focus && !["textbox", "searchbox", "spinbutton", "combobox"].includes(bound.role)) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Native accessibility reference is not an editable field.");
  }
  await chrome.debugger.sendCommand(target, "Accessibility.enable");
  const refreshed = await chrome.debugger.sendCommand(target, "Accessibility.getPartialAXTree", {
    backendNodeId: bound.backendDOMNodeId, fetchRelatives: false,
  });
  const current = (refreshed?.nodes ?? []).find((node) => node.backendDOMNodeId === bound.backendDOMNodeId);
  if (!current || current.ignored || current.role?.value !== bound.role ||
      String(current.name?.value ?? "").replace(/\\s+/gu, " ").trim().slice(0, 500) !== bound.name) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The native accessibility control changed.");
  }
  const box = await chrome.debugger.sendCommand(target, "DOM.getBoxModel", {
    backendNodeId: bound.backendDOMNodeId,
  });
  const quad = box?.model?.content;
  if (!Array.isArray(quad) || quad.length !== 8 || quad.some((n) => !Number.isFinite(n))) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The native accessibility control is not visible.");
  }
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
  const viewport = metrics?.cssVisualViewport ?? metrics?.visualViewport;
  if (!viewport || x < 0 || y < 0 || x >= viewport.clientWidth || y >= viewport.clientHeight) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The native accessibility target is outside the viewport.");
  }
  const hit = await chrome.debugger.sendCommand(target, "DOM.getNodeForLocation", {
    x: Math.round(x), y: Math.round(y), ignorePointerEventsNone: true,
  });
  if (hit?.backendNodeId !== bound.backendDOMNodeId) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The native accessibility target is obscured or changed.");
  }
  return { x, y };
}

async function click(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "click", false);
  if (!input.guard || input.guard.ref !== input.ref) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Chrome interaction requires a bound element guard.");
  }
  let point;
  if (!input.ref.startsWith("ax-")) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: probeGuardedElement,
      args: [input.ref, input.guard, false, input.x, input.y],
    });
    point = injection?.result;
    if (!point || point.error) throw coded("BROWSER_CONFIRMATION_INVALID", "The element changed since the personal browser snapshot.");
  }
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    throwIfAborted(signal, "click", false);
    if (input.ref.startsWith("ax-")) point = await resolveGuardedAxPoint(chromeTabId, input.ref, input.guard, target, false);
    const button = input.button ?? "left";
    const clickCount = input.clickCount ?? 1;
    const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
    const modifiers = (input.modifiers ?? []).reduce((mask, part) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[part] ?? 0), 0);
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, modifiers,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button, buttons, clickCount, modifiers,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount, modifiers,
    });
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable or occupied by DevTools.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function hover(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  if (!input.guard || input.guard.ref !== input.ref) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Hover requires a guard from the current snapshot.");
  }
  let point;
  if (!input.ref.startsWith("ax-")) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: probeGuardedElement,
      args: [input.ref, input.guard, false, input.x, input.y],
    });
    point = injection?.result;
    if (!point || point.error) throw coded("BROWSER_CONFIRMATION_INVALID", "Hover reference is stale or obscured.");
  }
  throwIfAborted(signal, "hover", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    if (input.ref.startsWith("ax-")) point = await resolveGuardedAxPoint(chromeTabId, input.ref, input.guard, target, false);
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, button: "none",
    });
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable or occupied by DevTools.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function drag(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const resolve = async (endpoint, guard) => {
    if (!endpoint || !endpoint.ref || !guard || guard.ref !== endpoint.ref) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "Drag requires a bound source and destination.");
    }
    if (endpoint.ref.startsWith("ax-")) return undefined;
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: probeGuardedElement,
      args: [endpoint.ref, guard, false, endpoint.x, endpoint.y],
    });
    if (!probe?.result || probe.result.error) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "Drag endpoint is stale, obscured or outside its observed control.");
    }
    return probe.result;
  };
  let from = await resolve(input.from, input.fromGuard);
  let to = await resolve(input.to, input.toGuard);
  const steps = input.steps ?? 10;
  if (!Number.isInteger(steps) || steps < 2 || steps > 40) {
    throw coded("INVALID_ARGUMENT", "Drag requires 2 to 40 movement steps.");
  }
  throwIfAborted(signal, "drag", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  let pressed = false;
  try {
    attached = await attachGuardedDebugger(target);
    if (input.from.ref.startsWith("ax-")) from = await resolveGuardedAxPoint(
      chromeTabId, input.from.ref, input.fromGuard, target, false,
    );
    if (input.to.ref.startsWith("ax-")) to = await resolveGuardedAxPoint(
      chromeTabId, input.to.ref, input.toGuard, target, false,
    );
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: from.x, y: from.y, button: "none",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1,
    });
    pressed = true;
    for (let i = 1; i <= steps; i += 1) {
      throwIfAborted(signal, "drag", true);
      const progress = i / steps;
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
        buttons: 1, button: "left",
      });
    }
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1,
    });
    pressed = false;
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (signal?.aborted) throw cancellationError("drag", signal, pressed);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable for drag-and-drop.");
  } finally {
    if (attached || globalThis.__mcpV3PersonalNetworkCaptures?.has(String(target.tabId))) {
      if (pressed) await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: to?.x ?? from?.x ?? 0, y: to?.y ?? from?.y ?? 0,
        button: "left", buttons: 0,
      }).catch(() => undefined);
      await detachGuardedDebugger(target, attached).catch(() => undefined);
    }
  }
}

async function scroll(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const tab = await chrome.tabs.get(chromeTabId);
  if (!input.guard || tab.url !== input.guard.url || (input.ref && input.guard.ref !== input.ref)) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Scroll requires a guard from the current page.");
  }
  let point;
  if (input.ref && !input.ref.startsWith("ax-")) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: probeGuardedElement,
      args: [input.ref, input.guard, false],
    });
    point = injection?.result;
    if (!point || point.error) throw coded("BROWSER_CONFIRMATION_INVALID", "Scroll target is stale or obscured.");
  } else if (!input.ref) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: (x, y) => {
        const px = x ?? Math.floor(innerWidth / 2);
        const py = y ?? Math.floor(innerHeight / 2);
        if (!Number.isInteger(px) || !Number.isInteger(py) ||
            px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) return null;
        return { x: px, y: py };
      },
      args: [input.x, input.y],
    });
    point = injection?.result;
    if (!point) {
      throw coded("INVALID_ARGUMENT", "Scroll coordinates are outside the current CSS viewport.");
    }
  }
  throwIfAborted(signal, "scroll", false);
  const deltaX = input.direction === "left" ? -input.amount : input.direction === "right" ? input.amount : 0;
  const deltaY = input.direction === "up" ? -input.amount : input.direction === "down" ? input.amount : 0;
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    if (input.ref?.startsWith("ax-")) point = await resolveGuardedAxPoint(chromeTabId, input.ref, input.guard, target, false);
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY,
    });
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable or occupied by DevTools.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function fill(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  if (!input.guard || input.guard.ref !== input.ref) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Chrome field input requires a bound element guard.");
  }
  if (!input.ref.startsWith("ax-")) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: probeGuardedElement,
      args: [input.ref, input.guard, true],
    });
    if (!injection?.result || injection.result.error) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "The field changed since the personal browser snapshot.");
    }
  }
  throwIfAborted(signal, "fill", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    if (input.ref.startsWith("ax-")) {
      const point = await resolveGuardedAxPoint(chromeTabId, input.ref, input.guard, target, true);
      for (const [type, button] of [["mouseMoved", "none"], ["mousePressed", "left"], ["mouseReleased", "left"]]) {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type, x: point.x, y: point.y, button, clickCount: 1,
        });
      }
    }
    // Select the focused field's existing content using trusted keyboard input.
    for (const event of [
      { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
      { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
      { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    ]) await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", event);
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: input.value });
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable or occupied by DevTools.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

function inspectGuardedForm(ref) {
  const element = globalThis.__mcpV3OwnedRefElements?.get(ref);
  if (!element?.isConnected || element.disabled) return { error: "missing_or_disabled" };
  const tag = element.tagName.toLowerCase();
  const type = String(element.getAttribute("type") || "text").toLowerCase();
  if (tag === "select") {
    return { kind: "select", multiple: element.multiple === true, options:
      Array.from(element.options || []).slice(0, 1000).map((option, index) => ({
        index, label: String(option.textContent || "").replace(/\\s+/gu, " ").trim().slice(0, 500),
        value: String(option.value || "").slice(0, 500),
        selected: option.selected === true, disabled: option.disabled === true,
      })),
    };
  }
  if (tag === "input" && ["checkbox", "radio"].includes(type)) {
    return { kind: type, checked: element.checked === true };
  }
  if (tag === "input" && type === "range") {
    return { kind: "range", min: Number(element.min || 0), max: Number(element.max || 100),
      step: Number(element.step || 1), value: Number(element.value) };
  }
  if (tag === "textarea" || tag === "input" && !["file", "hidden", "button", "submit", "reset", "image"].includes(type) ||
      element.isContentEditable) {
    return { kind: "text" };
  }
  return { error: "unsupported_control" };
}

async function formInput(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  if (!input.guard || input.guard.ref !== input.ref) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Form control requires a bound reference.");
  }
  const value = input.value;
  const ax = input.ref.startsWith("ax-");
  let inspected;
  let point;
  if (!ax) {
    const [observed] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId }, func: probeGuardedElement,
      args: [input.ref, input.guard, false],
    });
    point = observed?.result;
    if (!point || point.error) throw coded("BROWSER_CONFIRMATION_INVALID", "Form control is stale or obscured.");
    const [detail] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId }, func: inspectGuardedForm, args: [input.ref],
    });
    inspected = detail?.result;
    if (!inspected || inspected.error) throw coded("BROWSER_CONFIRMATION_INVALID", "Unsupported or stale form control.");
  }
  throwIfAborted(signal, "formInput", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    if (ax) {
      point = await resolveGuardedAxPoint(chromeTabId, input.ref, input.guard, target, false);
      const kind = input.guard.role;
      inspected = { kind: kind === "checkbox" || kind === "radio" ? kind :
        kind === "textbox" || kind === "searchbox" || kind === "spinbutton" ? "text" : "unsupported" };
      if (kind === "checkbox" || kind === "radio") {
        const record = axTargetsByTab.get(chromeTabId)?.targets.get(input.ref);
        const state = await chrome.debugger.sendCommand(target, "Accessibility.getPartialAXTree", {
          backendNodeId: record.backendDOMNodeId, fetchRelatives: false,
        });
        const checked = state?.nodes?.[0]?.properties?.find((property) => property.name === "checked")?.value?.value;
        inspected.checked = checked === "true" || checked === true;
      }
    }
    if (Array.isArray(value) && (!inspected.multiple || inspected.kind !== "select")) {
      if (value.length !== 1 || inspected.kind !== "select") {
        throw coded("INVALID_ARGUMENT", "Multiple options require a native multi-select control.");
      }
    }
    const dispatchKey = async (key, code, keyCode, modifiers = 0) => {
      for (const kind of ["keyDown", "keyUp"]) {
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
          type: kind, key, code, windowsVirtualKeyCode: keyCode, modifiers,
        });
      }
    };
    const clickPoint = async () => {
      for (const kind of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: kind, x: point.x, y: point.y, button: kind === "mouseMoved" ? "none" : "left",
          clickCount: 1,
        });
      }
    };
    if (typeof value === "boolean") {
      if (!["checkbox", "radio"].includes(inspected.kind) || inspected.kind === "radio" && !value) {
        throw coded("INVALID_ARGUMENT", "Boolean value requires a checkbox or a checked radio.");
      }
      if (inspected.checked !== value) await clickPoint();
    } else if (inspected.kind === "select") {
      const desired = (Array.isArray(value) ? value : [String(value)]);
      const options = inspected.options || [];
      const chosen = desired.map((item) => options.findIndex((o) => !o.disabled &&
        (o.value === item || o.label === item)));
      if (chosen.some((index) => index < 0)) throw coded("INVALID_ARGUMENT", "Requested select option does not exist.");
      if (inspected.multiple) {
        // Native listboxes: move with Control+Home/Down and toggle using Control+Space.
        await clickPoint();
        const current = new Set(options.filter((o) => o.selected).map((o) => o.index));
        const wanted = new Set(chosen);
        const changes = options.filter((o) => current.has(o.index) !== wanted.has(o.index));
        if (options.length > 100 || changes.length > 50) throw coded("LIMIT_EXCEEDED", "Multi-select keyboard action budget exceeded.");
        await dispatchKey("Home", "Home", 36, 2);
        let position = 0;
        for (const option of changes) {
          while (position < option.index) {
            await dispatchKey("ArrowDown", "ArrowDown", 40, 2);
            position += 1;
          }
          await dispatchKey(" ", "Space", 32, 2);
        }
      } else {
        if (desired.length !== 1) throw coded("INVALID_ARGUMENT", "Single-select accepts one option.");
        await clickPoint();
        await dispatchKey("Home", "Home", 36);
        for (let index = 0; index < chosen[0]; index += 1) {
          throwIfAborted(signal, "formInput", true);
          await dispatchKey("ArrowDown", "ArrowDown", 40);
        }
        await dispatchKey("Enter", "Enter", 13);
      }
    } else if (inspected.kind === "text" && !Array.isArray(value)) {
      await clickPoint();
      await dispatchKey("a", "KeyA", 65, 2);
      await dispatchKey("Backspace", "Backspace", 8);
      await chrome.debugger.sendCommand(target, "Input.insertText", { text: String(value) });
    } else if (inspected.kind === "range" && typeof value === "number") {
      const { min, max, step } = inspected;
      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0 ||
          value < min || value > max || Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-6) {
        throw coded("INVALID_ARGUMENT", "Slider value must match its legal range and step.");
      }
      const ticks = Math.round((value - min) / step);
      if (ticks > 1000) throw coded("LIMIT_EXCEEDED", "Slider requires too many keyboard inputs.");
      await clickPoint();
      await dispatchKey("Home", "Home", 36);
      for (let i = 0; i < ticks; i += 1) {
        throwIfAborted(signal, "formInput", true);
        await dispatchKey("ArrowRight", "ArrowRight", 39);
      }
    } else {
      throw coded("INVALID_ARGUMENT", "Value does not match the observed control type.");
    }
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome form control input is unavailable.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function typeText(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const tab = await chrome.tabs.get(chromeTabId);
  if (!input.guard || tab.url !== input.guard.url) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Chrome type input requires a bound page guard.");
  }
  if (input.slowly && Array.from(input.text).length > 2000) {
    throw coded("LIMIT_EXCEEDED", "Slow typing is limited to 2,000 characters.");
  }
  throwIfAborted(signal, "type", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    if (input.slowly) {
      for (const char of input.text) {
        throwIfAborted(signal, "type", true);
        await chrome.debugger.sendCommand(target, "Input.insertText", { text: char });
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    } else {
      await chrome.debugger.sendCommand(target, "Input.insertText", { text: input.text });
    }
    if (input.submit) {
      for (const kind of ["keyDown", "keyUp"]) {
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
          type: kind, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
        });
      }
    }
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (signal?.aborted) throw cancellationError("type", signal, true);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable or occupied by DevTools.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function press(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const tab = await chrome.tabs.get(chromeTabId);
  if (!input.guard || tab.url !== input.guard.url) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Chrome keyboard input requires the original page URL.");
  }
  const keys = String(input.key).trim().split(/\s+/u).map(parseChromeKey);
  const repeat = input.repeat ?? 1;
  if (keys.length * repeat > 100) throw coded("LIMIT_EXCEEDED", "Chrome key sequence exceeds 100 inputs.");
  if (repeat > 1 && keys.some((key) => key.key === "Enter")) throw coded("ACTION_BLOCKED_BY_POLICY", "Repeating Enter can submit multiple forms.");
  throwIfAborted(signal, "press", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    for (let n = 0; n < repeat; n += 1) {
      for (const key of keys) {
        throwIfAborted(signal, "press", true);
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
          type: "keyDown", key: key.key, code: key.code,
          windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode,
          modifiers: key.modifiers, ...(key.text ? { text: key.text } : {}),
        });
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
          type: "keyUp", key: key.key, code: key.code,
          windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode,
          modifiers: key.modifiers,
        });
      }
    }
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable or occupied by DevTools.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
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
    const started = performance.now();
    let value;
    if (step.action === "navigate") value = await navigate({ tabId: input.tabId, url: step.url }, signal);
    else if (step.action === "click") value = await click({ tabId: input.tabId, ref: step.ref, guard: step.guard, button: step.button, clickCount: step.clickCount, modifiers: step.modifiers }, signal);
    else if (step.action === "fill") value = await fill({ tabId: input.tabId, ref: step.ref, value: step.value, guard: step.guard }, signal);
    else if (step.action === "hover") value = await hover({ tabId: input.tabId, ref: step.ref, guard: step.guard }, signal);
    else if (step.action === "scroll") value = await scroll({ tabId: input.tabId, direction: step.direction, amount: step.amount, ref: step.ref, guard: step.guard }, signal);
    else if (step.action === "drag") value = await drag({ tabId: input.tabId, from: step.from, to: step.to, steps: step.steps, fromGuard: step.fromGuard, toGuard: step.toGuard }, signal);
    else if (step.action === "formInput") value = await formInput({ tabId: input.tabId, ref: step.ref, value: step.value, guard: step.guard }, signal);
    else if (step.action === "type") value = await typeText({ tabId: input.tabId, text: step.text, slowly: step.slowly, submit: step.submit, guard: step.guard }, signal);
    else if (step.action === "press") value = await press({ tabId: input.tabId, key: step.key, repeat: step.repeat, guard: step.guard }, signal);
    else if (step.action === "wait") value = await wait({ tabId: input.tabId, timeoutMs: step.timeoutMs, text: step.text, ref: step.ref }, signal);
    else if (step.action === "extract") value = await extract({ tabId: input.tabId, ref: step.ref, selector: step.selector, format: step.format }, signal);
    results.push({
      index,
      action: step.action,
      completed: true,
      durationMs: Math.max(0, performance.now() - started),
      ...(step.action === "extract" ? { value: value.value } : {}),
    });
  }
  const response = { tabId: input.tabId, completed: true, steps: results,
    actionSummary: results.map((r) => ({ index: r.index, action: r.action, durationMs: r.durationMs })),
  };
  if (input.finalSnapshot) {
    const started = performance.now();
    try { response.snapshot = await snapshot({ tabId: input.tabId }, signal); }
    finally { if (timing) timing.snapshotMs += performance.now() - started; }
  }
  return response;
}

async function readPersonalConsole(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "console", false);
  if (!chrome.debugger?.onEvent?.addListener || !chrome.debugger?.onEvent?.removeListener) {
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger console events are unavailable.");
  }
  const pattern = input.pattern;
  if (pattern !== undefined && (typeof pattern !== "string" || pattern.length > 500 || /[\\r\\n\\0]/u.test(pattern))) {
    throw coded("INVALID_ARGUMENT", "Invalid console pattern.");
  }
  let filter;
  try {
    filter = pattern ? new RegExp(pattern, "u") : undefined;
  } catch {
    throw coded("INVALID_ARGUMENT", "Console regex is not valid.");
  }
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw coded("INVALID_ARGUMENT", "Console message limit must be between 1 and 1000.");
  }
  const tabKey = String(chromeTabId);
  const recorded = personalConsoleEntries.get(tabKey) ?? [];
  let attached = false;
  let truncated = false;
  const listener = (source, method, params) => {
    if (source?.tabId !== chromeTabId) return;
    let level;
    let message;
    if (method === "Runtime.consoleAPICalled") {
      const type = params?.type;
      level = type === "error" || type === "assert" ? "error" :
        type === "warning" || type === "warn" ? "warning" :
        type === "debug" || type === "verbose" ? "debug" : "info";
      const values = Array.isArray(params?.args) ? params.args.slice(0, 12) : [];
      message = values.map((entry) => {
        if (entry?.value === null) return "null";
        if (typeof entry?.value === "string") return entry.value.slice(0, 1800);
        if (typeof entry?.value === "number" || typeof entry?.value === "boolean") return String(entry.value);
        return String(entry?.description ?? "[object]").slice(0, 1800);
      }).join(" ");
    } else if (method === "Runtime.exceptionThrown") {
      level = "error";
      message = String(params?.exceptionDetails?.text ?? "Script exception");
    } else if (method === "Log.entryAdded") {
      const entry = params?.entry;
      level = entry?.level === "error" ? "error" : entry?.level === "warning" ? "warning" :
        entry?.level === "verbose" ? "debug" : "info";
      message = String(entry?.text ?? "");
    } else return;
    const line = "[" + level + "] " + sanitizePersonalDiagnosticText(message.slice(0, 3000));
    if (recorded.length >= 500) {
      recorded.shift();
      truncated = true;
    }
    recorded.push(line);
  };
  try {
    chrome.debugger.onEvent.addListener(listener);
    const target = { tabId: chromeTabId };
    attached = await attachGuardedDebugger(target);
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
    await new Promise((resolve) => setTimeout(resolve, 120));
    throwIfAborted(signal, "console", false);
    personalConsoleEntries.set(tabKey, recorded);
    const threshold = input.onlyErrors ? "error" : input.level;
    const severities = { error: 0, warning: 1, info: 2, debug: 3 };
    const output = recorded.filter((line) => {
      const level = line.slice(1, line.indexOf("]"));
      return (!threshold || (severities[level] ?? 3) <= severities[threshold]) &&
        (!filter || filter.test(line));
    });
    const text = output.slice(0, limit).join("\\n").slice(0, 120000);
    const result = {
      tabId: input.tabId, text,
      truncated: truncated || output.length > limit || output.join("\\n").length > 120000,
      collectedAt: new Date().toISOString(),
    };
    if (input.clear === true) personalConsoleEntries.delete(tabKey);
    return result;
  } catch (error) {
    if (signal?.aborted) throw cancellationError("console", signal, false);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger console capture is unavailable or occupied.");
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    await detachGuardedDebugger({ tabId: chromeTabId }, attached).catch(() => undefined);
  }
}

function safeNetworkUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "[unsupported URL]";
    return (url.origin + url.pathname).slice(0, 1500);
  } catch {
    return "[invalid URL]";
  }
}

function safeNetworkHeaders(raw) {
  const sanitized = {};
  if (!raw || typeof raw !== "object") return sanitized;
  for (const [key, value] of Object.entries(raw).slice(0, 100)) {
    const name = String(key).slice(0, 90);
    if (!/^[A-Za-z0-9-]+$/u.test(name)) continue;
    if (/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|sec-websocket-protocol)$/iu.test(name) ||
        /(?:token|secret|key|password|credential|session|auth)/iu.test(name)) {
      sanitized[name] = "[redacted]";
    } else {
      sanitized[name] = sanitizePersonalDiagnosticText(String(value).slice(0, 1200));
    }
  }
  return sanitized;
}

function safeNetworkBody(raw, mime, base64Encoded) {
  const contentType = String(mime ?? "").toLowerCase();
  if (!/^(?:text\\/|application\\/(?:json|(?:[\\w.-]+\\+)?json|xml|(?:[\\w.-]+\\+)?xml|javascript|x-www-form-urlencoded))/u.test(contentType)) {
    return "[binary response omitted]";
  }
  let text = String(raw ?? "");
  if (base64Encoded) {
    if (text.length > 350000 || typeof atob !== "function") return "[response exceeds decoding limit]";
    try {
      const decoded = atob(text);
      const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return "[response decode unavailable]";
    }
  }
  if (text.length > 256 * 1024) text = text.slice(0, 256 * 1024) + "[truncated]";
  return sanitizePersonalDiagnosticText(text, 256 * 1024).slice(0, 256 * 1024);
}

async function startPersonalNetworkCapture(chromeTabId, input) {
  const key = String(chromeTabId);
  if (personalNetworkCaptures.has(key)) {
    throw coded("INVALID_ARGUMENT", "Network capture already running on this tab. Read it or stop before restarting.");
  }
  const state = {
    entries: [], totalBytes: 0, truncated: false, pending: new Set(),
    captureHeaders: input.captureHeaders === true,
    captureBodies: input.captureBodies === true,
    active: true, listener: undefined,
  };
  const listener = (source, method, params) => {
    if (source?.tabId !== chromeTabId || !state.active) return;
    const id = String(params?.requestId ?? "").slice(0, 128);
    if (!id) return;
    let entry = state.entries.find((item) => item.id === id);
    if (method === "Network.requestWillBeSent") {
      if (!params?.request?.url) return;
      if (state.entries.length >= 256) {
        state.entries.shift();
        state.truncated = true;
      }
      entry = {
        id, method: String(params.request.method ?? "GET").slice(0, 16),
        url: safeNetworkUrl(params.request.url),
        resourceType: String(params.type ?? "Other").slice(0, 30),
        status: "pending", at: new Date().toISOString(), mime: "",
      };
      if (state.captureHeaders) entry.requestHeaders = safeNetworkHeaders(params.request.headers);
      if (state.captureBodies && params.request.postData !== undefined) {
        entry.requestBody = safeNetworkBody(params.request.postData,
          params.request.headers?.["Content-Type"] ?? params.request.headers?.["content-type"] ?? "text/plain", false);
      }
      const recordBytes = JSON.stringify(entry).length;
      if (state.totalBytes + recordBytes > 8 * 1024 * 1024) {
        state.truncated = true;
        return;
      }
      state.totalBytes += recordBytes;
      state.entries.push(entry);
    } else if (entry && method === "Network.responseReceived") {
      const status = Number(params?.response?.status);
      entry.status = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "unknown";
      entry.mime = String(params?.response?.mimeType ?? "").toLowerCase().slice(0, 150);
      if (state.captureHeaders) {
        const safe = safeNetworkHeaders(params.response.headers);
        const size = JSON.stringify(safe).length;
        if (state.totalBytes + size <= 8 * 1024 * 1024) {
          entry.responseHeaders = safe;
          state.totalBytes += size;
        } else {
          state.truncated = true;
        }
      }
    } else if (entry && method === "Network.loadingFailed") {
      entry.status = "failed";
    } else if (entry && method === "Network.loadingFinished" && state.captureBodies && state.totalBytes < 8 * 1024 * 1024) {
      if (!/^(?:text\\/|application\\/(?:json|(?:[\\w.-]+\\+)?json|xml|(?:[\\w.-]+\\+)?xml|javascript|x-www-form-urlencoded))/u.test(entry.mime)) {
        entry.responseBody = "[binary response omitted]";
        return;
      }
      const target = { tabId: chromeTabId };
      const record = entry;
      const pending = chrome.debugger.sendCommand(target, "Network.getResponseBody", { requestId: id })
        .then((result) => {
          if (!result || typeof result.body !== "string") return;
          if (result.body.length > 400000) {
            record.responseBody = "[response exceeds size limit]";
            state.truncated = true;
            return;
          }
          const body = safeNetworkBody(result.body, record.mime, result.base64Encoded === true);
          const len = body.length;
          if (state.totalBytes + len > 8 * 1024 * 1024) {
            record.responseBody = "[capture quota exceeded]";
            state.truncated = true;
            return;
          }
          state.totalBytes += len;
          record.responseBody = body;
        }).catch(() => {
          record.responseBody = "[response unavailable]";
        }).finally(() => state.pending.delete(pending));
      state.pending.add(pending);
    }
  };
  state.listener = listener;
  state.borrowers = 0;
  let attached = false;
  try {
    chrome.debugger.onEvent.addListener(listener);
    attached = await attachGuardedDebugger({ tabId: chromeTabId });
    await chrome.debugger.sendCommand({ tabId: chromeTabId }, "Network.enable", {
      maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 256 * 1024,
    });
    state.attached = attached;
    personalNetworkCaptures.set(key, state);
    globalThis.__mcpV3PersonalNetworkCaptures = personalNetworkCaptures;
  } catch (error) {
    state.active = false;
    chrome.debugger.onEvent.removeListener(listener);
    await detachGuardedDebugger({ tabId: chromeTabId }, attached).catch(() => undefined);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable for network capture.");
  }
}

async function stopPersonalNetworkCapture(chromeTabId) {
  const key = String(chromeTabId);
  const state = personalNetworkCaptures.get(key);
  if (!state) return;
  if ((state.borrowers ?? 0) > 0) throw coded("EXECUTION_STATE_INVALID", "Network capture is still in use by a browser interaction.");
  personalNetworkCaptures.delete(key);
  state.active = false;
  chrome.debugger.onEvent.removeListener(state.listener);
  await Promise.allSettled([...state.pending]);
  personalNetworkEntries.set(key, { entries: state.entries, truncated: state.truncated });
  await detachGuardedDebugger({ tabId: chromeTabId }, state.attached === true).catch(() => undefined);
}

async function readPersonalNetwork(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "networkList", false);
  const key = String(chromeTabId);
  const capture = input.capture ?? "read";
  if (capture === "start") {
    await startPersonalNetworkCapture(chromeTabId, input);
  } else if (capture === "stop") {
    await stopPersonalNetworkCapture(chromeTabId);
  } else if (!personalNetworkCaptures.has(key) && !personalNetworkEntries.has(key)) {
    await startPersonalNetworkCapture(chromeTabId, input);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      await stopPersonalNetworkCapture(chromeTabId);
    }
  }
  throwIfAborted(signal, "networkList", false);
  const state = personalNetworkCaptures.get(key) ?? personalNetworkEntries.get(key) ?? { entries: [], truncated: false };
  let expression;
  try {
    const filter = input.filter;
    if (filter !== undefined && (typeof filter !== "string" || filter.length > 500 || filter.includes(String.fromCharCode(10)) ||
      filter.includes(String.fromCharCode(13)) || filter.includes(String.fromCharCode(0)))) {
      throw coded("INVALID_ARGUMENT", "Invalid network filter.");
    }
    expression = filter ? new RegExp(filter, "u") : undefined;
  } catch (error) {
    if (error?.code) throw error;
    throw coded("INVALID_ARGUMENT", "Invalid network regular expression.");
  }
  const lines = [];
  for (const [index, entry] of state.entries.entries()) {
    if (!input.includeStatic && ["Image", "Font", "Stylesheet", "Media"].includes(entry.resourceType)) continue;
    if (expression && !expression.test(entry.url)) continue;
    lines.push(String(index + 1) + ". " + entry.method + " " + entry.url + " " + entry.status);
  }
  const full = lines.join(String.fromCharCode(10));
  const result = {
    tabId: input.tabId, text: sanitizePersonalDiagnosticText(full.slice(0, 120000), 120000),
    truncated: state.truncated || full.length > 120000,
    collectedAt: new Date().toISOString(),
  };
  if (input.clear === true) {
    await stopPersonalNetworkCapture(chromeTabId);
    personalNetworkEntries.delete(key);
  }
  return result;
}

async function inspectPersonalNetwork(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "networkInspect", false);
  if (!Number.isInteger(input.index) || input.index < 1) {
    throw coded("INVALID_ARGUMENT", "Network index must be positive.");
  }
  const data = personalNetworkCaptures.get(String(chromeTabId)) ?? personalNetworkEntries.get(String(chromeTabId));
  if (input.detail === "response-body" && data?.pending?.size) {
    await Promise.allSettled([...data.pending]);
  }
  const item = data?.entries?.[input.index - 1];
  if (!item) throw coded("INVALID_ARGUMENT", "Network request index was not found.");
  const detail = input.detail ?? "request";
  let value;
  if (detail === "request") value = {
    method: item.method, url: item.url, resourceType: item.resourceType,
    status: item.status, timestamp: item.at,
  };
  else if (detail === "request-headers" || detail === "response-headers") {
    const key = detail === "request-headers" ? "requestHeaders" : "responseHeaders";
    if (!Object.hasOwn(item, key)) {
      throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Headers were not captured. Start network capture with captureHeaders=true.");
    }
    value = item[key];
  } else if (detail === "request-body" || detail === "response-body") {
    const key = detail === "request-body" ? "requestBody" : "responseBody";
    if (!Object.hasOwn(item, key)) {
      throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Body was not captured. Start network capture with captureBodies=true, then retry.");
    }
    value = item[key];
  } else throw coded("INVALID_ARGUMENT", "Unsupported network detail.");
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return { tabId: input.tabId, text: sanitizePersonalDiagnosticText(raw.slice(0, 256 * 1024), 256 * 1024),
    truncated: raw.length > 256 * 1024, collectedAt: new Date().toISOString() };
}

function safeChromeDownloadName(raw) {
  const pieces = String(raw ?? "download.bin").split("/").pop().split(String.fromCharCode(92));
  const last = pieces[pieces.length - 1] ?? "download.bin";
  const name = [...last].map((character) => character.charCodeAt(0) < 32 ||
    '<>:"/|?*'.includes(character) || character === String.fromCharCode(92)
    ? "_" : character).join("").replace(/[. ]+$/u, "").slice(0, 160);
  return name && name !== "." && name !== ".." ? name : "download.bin";
}

async function downloadPersonalFile(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "download", false);
  const tab = await chrome.tabs.get(chromeTabId);
  if (!input.guard || tab.url !== input.guard.url || Boolean(input.ref) === Boolean(input.url)) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Download must target one URL or snapshot ref on an owned tab.");
  }
  if ((input.url && !chrome.downloads?.download) || !chrome.downloads?.search ||
      !chrome.downloads?.onCreated?.addListener ||
      !chrome.downloads?.onDeterminingFilename?.addListener) {
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome downloads API is not available.");
  }
  if (typeof input.runId !== "string" || !/^[a-f0-9-]{36}$/u.test(input.runId)) {
    throw coded("INVALID_ARGUMENT", "Download requires a one-time private staging identifier.");
  }
  const prefix = "MCP-V3-Staging/" + input.runId + "/";
  const safeName = safeChromeDownloadName(input.url
    ? new URL(input.url).pathname.split("/").pop()
    : "download.bin");
  let downloadId;
  let createdListener;
  let changedListener;
  let filenameListener;
  let cdpListener;
  let chooserTimer;
  let attached = false;
  let success = false;
  const target = { tabId: chromeTabId };
  const awaitingFilename = new Map();
  const createdCandidates = new Map();
  let cdpDownloadUrl;
  const matchesDownload = (item) =>
    Boolean(cdpDownloadUrl && (item?.url === cdpDownloadUrl ||
      item?.finalUrl === cdpDownloadUrl));
  const supplyFilename = (id, item, callback) => {
    const stored = awaitingFilename.get(id);
    if (stored) {
      clearTimeout(stored.timer);
      awaitingFilename.delete(id);
    }
    if (typeof callback === "function") {
      callback({ filename: prefix + safeChromeDownloadName(item.filename || item.url),
        conflictAction: "uniquify" });
    }
  };
  try {
    if (input.url) {
      const url = assertPersonalNavigationTarget(input.url);
      downloadId = await chrome.downloads.download({
        url, filename: prefix + safeName, saveAs: false, conflictAction: "uniquify",
      });
      if (!Number.isInteger(downloadId)) {
        throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome did not start an authorized download.");
      }
    } else {
      if (input.guard.ref !== input.ref || !chrome.debugger?.onEvent?.addListener) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "Download requires a fresh guarded ref and tab-scoped CDP.");
      }
      let resolveCreated;
      let rejectCreated;
      const created = new Promise((resolve, reject) => {
        resolveCreated = resolve;
        rejectCreated = reject;
      });
      void created.catch(() => undefined);
      const matchCandidates = () => {
        if (!cdpDownloadUrl || Number.isInteger(downloadId)) return;
        const matches = [...createdCandidates.values()].filter(matchesDownload);
        if (matches.length > 1) {
          rejectCreated(coded("BROWSER_CONFIRMATION_INVALID", "Ambiguous simultaneous download attribution."));
          return;
        }
        if (matches.length !== 1) return;
        const chosen = matches[0];
        downloadId = chosen.id;
        const waiting = awaitingFilename.get(downloadId);
        if (waiting) supplyFilename(downloadId, waiting.item, waiting.suggest);
        resolveCreated(downloadId);
      };
      chooserTimer = setTimeout(() =>
        rejectCreated(coded("EXECUTION_STATE_INVALID", "The guarded link did not start a verifiable owned-tab download.")), 15000);
      cdpListener = (source, method, params) => {
        if (source?.tabId !== chromeTabId ||
            !["Page.downloadWillBegin", "Browser.downloadWillBegin"].includes(method) ||
            typeof params?.url !== "string") return;
        // CDP is attached only to the MCP-owned tab. It is the provenance evidence:
        // downloads.DownloadItem itself does NOT contain a tabId.
        if (cdpDownloadUrl && cdpDownloadUrl !== params.url) {
          rejectCreated(coded("BROWSER_CONFIRMATION_INVALID", "Multiple downloads began from one guarded click."));
          return;
        }
        cdpDownloadUrl = params.url;
        matchCandidates();
      };
      createdListener = (item) => {
        if (!Number.isInteger(item?.id) || typeof item?.url !== "string") return;
        createdCandidates.set(item.id, item);
        if (createdCandidates.size > 20) {
          rejectCreated(coded("EXECUTION_STATE_INVALID", "Too many concurrent browser downloads for safe attribution."));
          return;
        }
        matchCandidates();
      };
      changedListener = (delta) => {
        const candidate = createdCandidates.get(delta?.id);
        if (!candidate) return;
        if (typeof delta?.finalUrl?.current === "string") {
          candidate.finalUrl = delta.finalUrl.current;
          matchCandidates();
        }
      };
      filenameListener = (item, suggest) => {
        if (!Number.isInteger(item?.id)) {
          suggest();
          return;
        }
        if (Number.isInteger(downloadId)) {
          if (item.id === downloadId) {
            supplyFilename(item.id, item, suggest);
          } else {
            suggest();
          }
          return;
        }
        // The filename callback can arrive before the tab-scoped CDP event.
        // Briefly defer, then release unrelated downloads unchanged.
        const timer = setTimeout(() => {
          awaitingFilename.delete(item.id);
          suggest();
        }, 1000);
        awaitingFilename.set(item.id, { item, suggest, timer });
        matchCandidates();
        return true;
      };
      chrome.debugger.onEvent.addListener(cdpListener);
      chrome.downloads.onCreated.addListener(createdListener);
      if (chrome.downloads.onChanged?.addListener) chrome.downloads.onChanged.addListener(changedListener);
      chrome.downloads.onDeterminingFilename.addListener(filenameListener);
      let point;
      if (!input.ref.startsWith("ax-")) {
        const [hit] = await chrome.scripting.executeScript({
          target, func: probeGuardedElement,
          args: [input.ref, input.guard, false],
        });
        point = hit?.result;
        if (!point || point.error) {
          throw coded("BROWSER_CONFIRMATION_INVALID", "Download link changed since the snapshot.");
        }
      }
      attached = await attachGuardedDebugger(target);
      await chrome.debugger.sendCommand(target, "Page.enable");
      if (input.ref.startsWith("ax-")) {
        point = await resolveGuardedAxPoint(chromeTabId, input.ref, input.guard, target, false);
      }
      for (const [type, buttons] of [["mouseMoved", 0], ["mousePressed", 1], ["mouseReleased", 0]]) {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left",
          buttons, clickCount: 1,
        });
      }
      downloadId = await created;
    }
    throwIfAborted(signal, "download", true);
    const started = Date.now();
    let download;
    while (Date.now() - started < 45000) {
      const rows = await chrome.downloads.search({ id: downloadId });
      const current = Array.isArray(rows) ? rows[0] : undefined;
      if (current?.state === "interrupted") {
        throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome interrupted the authorized download.");
      }
      if (current?.state === "complete" && typeof current.filename === "string") {
        if (current.danger && !["safe", "accepted", "allowlistedByPolicy", "deepScannedSafe"].includes(current.danger)) {
          throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome marked the downloaded file as unsafe.");
        }
        download = current;
        break;
      }
      throwIfAborted(signal, "download", true);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!download) {
      throw coded("EXECUTION_STATE_INVALID", "Download did not finish within 45 seconds.");
    }
    const filename = String(download.filename);
    const normalized = filename.replaceAll(String.fromCharCode(92), "/");
    if (!normalized.includes("/" + prefix) && !normalized.endsWith(prefix + safeName)) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "Chrome did not save the download inside private staging.");
    }
    const result = { tabId: input.tabId, path: filename,
      suggestedFilename: safeChromeDownloadName(filename),
      ...(Number.isSafeInteger(download.fileSize) && download.fileSize >= 0
        ? { sizeBytes: download.fileSize } : {}),
    };
    success = true;
    return result;
  } catch (error) {
    if (signal?.aborted) throw cancellationError("download", signal, true);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome could not download the guarded resource.");
  } finally {
    if (chooserTimer) clearTimeout(chooserTimer);
    if (createdListener) chrome.downloads.onCreated.removeListener(createdListener);
    if (changedListener) chrome.downloads.onChanged?.removeListener(changedListener);
    if (filenameListener) chrome.downloads.onDeterminingFilename.removeListener(filenameListener);
    if (cdpListener) chrome.debugger.onEvent.removeListener(cdpListener);
    for (const pending of awaitingFilename.values()) {
      clearTimeout(pending.timer);
      pending.suggest();
    }
    awaitingFilename.clear();
    await detachGuardedDebugger(target, attached).catch(() => undefined);
    if (!success && Number.isInteger(downloadId)) {
      await chrome.downloads.cancel(downloadId).catch(() => undefined);
    }
  }
}

async function uploadPersonalFiles(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "upload", false);
  const tab = await chrome.tabs.get(chromeTabId);
  if (!input.guard || tab.url !== input.guard.url) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Upload must be bound to the inspected owned tab and URL.");
  }
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 10 ||
      input.files.some((item) => !item || typeof item.path !== "string" ||
        item.path.length > 4096 || item.path.length < 4 ||
        typeof item.name !== "string" || item.name.length < 1 || item.name.length > 255)) {
    throw coded("INVALID_ARGUMENT", "Upload requires private staged file paths from the trusted companion.");
  }
  const totalBytes = Number(input.totalBytes);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > 60 * 1024 * 1024) {
    throw coded("LIMIT_EXCEEDED", "Upload exceeds the aggregate file size budget.");
  }
  if (input.inputRef && input.guard.ref !== input.inputRef ||
      input.triggerRef && input.guard.ref !== input.triggerRef ||
      !input.inputRef && !input.triggerRef && !input.selector) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Upload target guard does not match the authorized element.");
  }
  const target = { tabId: chromeTabId };
  let attached = false;
  let chooserListener;
  let chooserIntercepted = false;
  try {
    attached = await attachGuardedDebugger(target);
    await chrome.debugger.sendCommand(target, "DOM.enable");
    const verifiedFileNode = async (options) => {
      const described = await chrome.debugger.sendCommand(target, "DOM.describeNode", options);
      const node = described?.node;
      if (!node || String(node.nodeName ?? "").toUpperCase() !== "INPUT") {
        throw coded("BROWSER_CONFIRMATION_INVALID", "Selected upload target is not a file input.");
      }
      const attrs = Array.isArray(node.attributes) ? node.attributes : [];
      const typeAt = attrs.findIndex((value, index) => index % 2 === 0 && value === "type");
      if (typeAt < 0 || String(attrs[typeAt + 1] ?? "").toLowerCase() !== "file") {
        throw coded("BROWSER_CONFIRMATION_INVALID", "Selected upload input changed type.");
      }
      return options;
    };
    let node;
    if (input.triggerRef) {
      // CDP intercepts the page's real file chooser; no synthetic file input events.
      await chrome.debugger.sendCommand(target, "Page.enable");
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: true });
      chooserIntercepted = true;
      let resolveChooser;
      const chooser = new Promise((resolve, reject) => {
        resolveChooser = resolve;
        const timer = setTimeout(() => reject(coded("EXECUTION_STATE_INVALID", "No file chooser appeared on the authorized tab.")), 10000);
        chooserListener = (source, method, params) => {
          if (source?.tabId !== chromeTabId || method !== "Page.fileChooserOpened") return;
          clearTimeout(timer);
          if (!Number.isInteger(params?.backendNodeId)) {
            reject(coded("BROWSER_CONFIRMATION_INVALID", "Chrome file chooser did not identify a file input."));
          } else resolve(params.backendNodeId);
        };
        chrome.debugger.onEvent.addListener(chooserListener);
      });
      void chooser.catch(() => undefined);
      // Dispatch trusted CDP mouse events while retaining this tab's debugger session.
      let point;
      if (input.triggerRef.startsWith("ax-")) {
        point = await resolveGuardedAxPoint(chromeTabId, input.triggerRef, input.guard, target, false);
      } else {
        const [hit] = await chrome.scripting.executeScript({
          target: { tabId: chromeTabId }, func: probeGuardedElement,
          args: [input.triggerRef, input.guard, false],
        });
        point = hit?.result;
        if (!point || point.error) {
          throw coded("BROWSER_CONFIRMATION_INVALID", "File chooser trigger is stale or obscured.");
        }
      }
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: point.x, y: point.y,
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: point.x, y: point.y,
        button: "left", buttons: 1, clickCount: 1,
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: point.x, y: point.y,
        button: "left", buttons: 0, clickCount: 1,
      });
      const backendNodeId = await chooser;
      node = await verifiedFileNode({ backendNodeId });
    } else if (input.inputRef && input.inputRef.startsWith("ax-")) {
      const record = axTargetsByTab.get(chromeTabId);
      const bound = record?.targets?.get(input.inputRef);
      if (!bound || record.url !== tab.url) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "Upload accessibility ref is stale.");
      }
      node = await verifiedFileNode({ backendNodeId: bound.backendDOMNodeId });
    } else {
      let selector = input.selector;
      let position = 0;
      if (input.inputRef) {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: chromeTabId },
          func: (ref) => {
            const element = globalThis.__mcpV3OwnedRefElements?.get(ref);
            if (!element || !element.isConnected || element.tagName !== "INPUT" ||
                element.type !== "file") return null;
            const candidates = [...document.querySelectorAll("input[type=file]")];
            const index = candidates.indexOf(element);
            return index < 0 ? null : index;
          },
          args: [input.inputRef],
        });
        if (!Number.isInteger(injection?.result) || injection.result < 0) {
          throw coded("BROWSER_CONFIRMATION_INVALID", "Upload input ref changed; capture a fresh snapshot.");
        }
        selector = "input[type=file]";
        position = injection.result;
      }
      if (!selector || selector.length > 2000) {
        throw coded("INVALID_ARGUMENT", "A valid upload input selector is required.");
      }
      const document = await chrome.debugger.sendCommand(target, "DOM.getDocument", {
        depth: 1, pierce: true,
      });
      const rootId = document?.root?.nodeId;
      if (!Number.isInteger(rootId)) {
        throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome DOM root is unavailable for native upload.");
      }
      const matches = await chrome.debugger.sendCommand(target, "DOM.querySelectorAll", {
        nodeId: rootId, selector,
      });
      const ids = matches?.nodeIds;
      if (!Array.isArray(ids) || !Number.isInteger(ids[position]) ||
          (!input.inputRef && ids.length !== 1)) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "Native upload target was not found uniquely.");
      }
      node = await verifiedFileNode({ nodeId: ids[position] });
    }
    throwIfAborted(signal, "upload", false);
    await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
      ...node, files: input.files.map((item) => item.path),
    });
    throwIfAborted(signal, "upload", true);
    return { tabId: input.tabId, completed: true, fileCount: input.files.length, totalBytes };
  } catch (error) {
    if (signal?.aborted) throw cancellationError("upload", signal, true);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome native file chooser is unavailable for this owned tab.");
  } finally {
    if (chooserListener) chrome.debugger.onEvent.removeListener(chooserListener);
    if (chooserIntercepted) {
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", {
        enabled: false,
      }).catch(() => undefined);
    }
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function printPersonalPdf(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "pdf", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    await chrome.debugger.sendCommand(target, "Page.enable");
    const response = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      transferMode: "ReturnAsBase64",
    });
    throwIfAborted(signal, "pdf", false);
    const data = response?.data;
    if (typeof data !== "string" || data.length < 12 ||
        data.length > 17 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
      throw coded("LIMIT_EXCEEDED", "Chrome returned an invalid or oversized PDF payload.");
    }
    const sizeBytes = base64ByteLength(data);
    if (!Number.isFinite(sizeBytes) || sizeBytes > 12 * 1024 * 1024) {
      throw coded("LIMIT_EXCEEDED", "Chrome PDF exceeds the 12 MiB private artifact budget.");
    }
    return { tabId: input.tabId, kind: "pdf", contentBase64: data, sizeBytes,
      createdAt: new Date().toISOString() };
  } catch (error) {
    if (signal?.aborted) throw cancellationError("pdf", signal, false);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome cannot print this MCP-owned tab to PDF.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function screenshot(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "screenshot", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    await chrome.debugger.sendCommand(target, "Page.enable");
    let clip;
    if (input.region) {
      if (input.fullPage === true) {
        throw coded("INVALID_ARGUMENT", "Region screenshot cannot also be full page.");
      }
      const box = input.region;
      const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
      const view = metrics?.cssVisualViewport ?? metrics?.visualViewport;
      const { x, y, width, height } = box;
      if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 ||
          width <= 0 || height <= 0 || width * height > 12000000 ||
          !Number.isFinite(view?.clientWidth) || !Number.isFinite(view?.clientHeight) ||
          x + width > view.clientWidth || y + height > view.clientHeight) {
        throw coded("INVALID_ARGUMENT", "Screenshot region must fit the current CSS viewport and pixel budget.");
      }
      let scale = 1;
      if (input.scale === "device") {
        const dpr = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression: "window.devicePixelRatio", returnByValue: true,
        });
        scale = Number(dpr?.result?.value);
        if (!Number.isFinite(scale) || scale < 1 || scale > 4) {
          throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome returned an invalid device scale.");
        }
      }
      if (width * height * scale * scale > MAX_FULL_PAGE_PIXELS) {
        throw coded("LIMIT_EXCEEDED", "Screenshot scaling exceeds the image pixel budget.");
      }
      clip = {
        x: (Number(view.pageX) || 0) + x,
        y: (Number(view.pageY) || 0) + y,
        width, height, scale,
      };
    }
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
    await detachGuardedDebugger(target, attached).catch(() => undefined);
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
  const metadata = await requireOwnedMetadata(chromeTabId, true);
  if (metadata.protected || metadata.sticky) {
    throw coded("TAB_PROTECTED", "The personal browser tab is protected and cannot be closed directly.");
  }
  await finalizePersonalDialog(chromeTabId, true);
  await resetPersonalViewport(chromeTabId).catch(() => undefined);
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

  for (const target of targets) {
    axTargetsByTab.delete(target.chromeTabId);
    await finalizePersonalDialog(target.chromeTabId, true);
    await resetPersonalViewport(target.chromeTabId).catch(() => undefined);
  }
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

async function requireOwnedMetadata(chromeTabId, forCleanup = false) {
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
    // Page-initiated navigation and redirects must not turn an authorized
    // public tab into an implicit private-site grant.
    if (!forCleanup) assertPersonalNavigationTarget(tab.url);
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
  axTargetsByTab.delete(chromeTabId);
  personalConsoleEntries.delete(String(chromeTabId));
  await stopPersonalNetworkCapture(chromeTabId);
  personalNetworkEntries.delete(String(chromeTabId));
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
  // Private isolated-world data: never mark, rewrite or clean the page's DOM.
  globalThis.__mcpV3PageInstanceId ??= generation;
  globalThis.__mcpV3StableElementRefs ??= new WeakMap();
  const selector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "canvas",
    "svg",
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
  const liveRefs = new Map();
  globalThis.__mcpV3OwnedRefElements = liveRefs;
  const refMetadata = new Map();
  globalThis.__mcpV3OwnedRefMetadata = refMetadata;
  const refLines = [];
  const elements = [];
  let visitedRoots = 0;
  let inspectedNodes = 0;
  const collect = (root, depth) => {
    if (depth > 6 || ++visitedRoots > 128 || inspectedNodes >= 10000 || elements.length >= 2000) return;
    for (const element of root.querySelectorAll(selector)) {
      if (elements.length >= 2000) break;
      elements.push(element);
    }
    // Open shadow roots are reachable through their host; closed roots and
    // cross-origin frames are not, and must not be silently claimed.
    for (const element of root.querySelectorAll("*")) {
      if (++inspectedNodes > 10000 || elements.length >= 2000) break;
      if (element.shadowRoot) collect(element.shadowRoot, depth + 1);
    }
  };
  collect(document, 0);
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
    let ref = globalThis.__mcpV3StableElementRefs.get(element);
    if (!ref) {
      ref = "p-" + generation + "-" + (refs.length + 1);
      globalThis.__mcpV3StableElementRefs.set(element, ref);
    }
    liveRefs.set(ref, element);
    const role = element.getAttribute("role") || defaultRole(element);
    const name = normalizeText(accessibleName(element)).slice(0, 500);
    const states = semanticStates(element, role);
    refs.push({ ref, role, name });
    refMetadata.set(ref, { ref, role, name });
    refLines.push(
      "- " + role +
      (name ? " " + JSON.stringify(name) : "") +
      (states.length ? " " + states.map((state) => "[" + state + "]").join(" ") : "") +
      " [ref=" + ref + "]",
    );
    if (refs.length >= 2000) break;
  }
  const pageText = (document.body?.innerText || "").slice(0, 180000);
  const refText = refLines.join("\\n");
  return {
    url: location.href,
    title: document.title || "",
    pageInstanceId: globalThis.__mcpV3PageInstanceId,
    content: pageText + (refText ? "\\n\\nInteractive elements:\\n" + refText : ""),
    refs,
  };

  function defaultRole(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "canvas" || tag === "svg") return "canvas";
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
    const root = element.getRootNode?.() || document;
    const labelledByText = labelledBy
      ? labelledBy.split(/\\s+/u)
        .map((id) => root.getElementById?.(id)?.innerText || root.getElementById?.(id)?.textContent || "")
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


function inspectPointInDocument(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
      x >= innerWidth || y >= innerHeight) return null;
  let top = document.elementFromPoint(x, y);
  for (let depth = 0; depth < 6; depth += 1) {
    const inner = top?.shadowRoot?.elementFromPoint?.(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  const live = globalThis.__mcpV3OwnedRefElements;
  const metadata = globalThis.__mcpV3OwnedRefMetadata;
  if (!live || !metadata) return null;
  for (let current = top; current; current = current.parentElement || current.getRootNode?.()?.host) {
    for (const [ref, element] of live) {
      if (element === current && element.isConnected) return metadata.get(ref) || null;
    }
  }
  return null;
}

function probeGuardedElement(ref, guard, focus, coordinateX, coordinateY) {
  if (!guard || guard.url !== location.href || guard.ref !== ref) return { error: "stale_page" };
  const element = globalThis.__mcpV3OwnedRefElements?.get(ref);
  if (!element || !element.isConnected) return { error: "stale_ref" };
  const tag = element.tagName.toLowerCase();
  const type = String(element.getAttribute("type") || "").toLowerCase();
  const role = element.getAttribute("role") ||
    (tag === "canvas" || tag === "svg" ? "canvas" : tag === "a" ? "link" : tag === "button" || tag === "summary" ? "button" :
      tag === "textarea" ? "textbox" : tag === "select" ? element.multiple ? "listbox" : "combobox" :
      tag === "input" ? ["button","submit","reset","image","file"].includes(type) ? "button" :
        type === "checkbox" ? "checkbox" : type === "radio" ? "radio" :
        type === "range" ? "slider" : type === "number" ? "spinbutton" : "textbox" : "generic");
  const labelledBy = element.getAttribute("aria-labelledby");
  const root = element.getRootNode?.() || document;
  const labelledByText = labelledBy ? labelledBy.split(/\\s+/u)
    .map((id) => root.getElementById?.(id)?.innerText || root.getElementById?.(id)?.textContent || "")
    .filter(Boolean).join(" ") : "";
  const labelsText = Array.from(element.labels || []).map((label) => label.innerText || label.textContent || "").filter(Boolean).join(" ");
  const safeButtonValue = tag === "input" && ["button","submit","reset"].includes(type) ? String(element.value || "") : "";
  const name = String(element.getAttribute("aria-label") || labelledByText || labelsText ||
    element.getAttribute("placeholder") || element.getAttribute("title") || safeButtonValue ||
    element.innerText || element.textContent || "").replace(/\\s+/gu, " ").trim().slice(0, 500);
  if (guard.role !== role || guard.name !== name) return { error: "target_changed" };
  if (focus && !(element instanceof HTMLInputElement && !["checkbox", "radio", "file", "button", "submit", "reset", "hidden"].includes(type)) &&
      !(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLElement && element.isContentEditable)) {
    return { error: "not_editable" };
  }
  element.scrollIntoView({ block: "center", inline: "center" });
  if (focus) element.focus?.();
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { error: "not_visible" };
  const x = coordinateX === undefined ? rect.left + rect.width / 2 : coordinateX;
  const y = coordinateY === undefined ? rect.top + rect.height / 2 : coordinateY;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < rect.left || y < rect.top ||
      x >= rect.right || y >= rect.bottom || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
    return { error: "point_outside_target" };
  }
  let top = document.elementFromPoint(x, y);
  for (let depth = 0; depth < 6; depth += 1) {
    const inner = top?.shadowRoot?.elementFromPoint?.(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  if (!top || (top !== element && !element.contains(top))) return { error: "obscured" };
  return { x, y };
}

function parseChromeKey(input) {
  const pieces = String(input).split("+").map((part) => part.trim()).filter(Boolean);
  if (pieces.length < 1 || pieces.length > 5) throw coded("INVALID_ARGUMENT", "Invalid Chrome key combination.");
  let modifiers = 0;
  for (const raw of pieces.slice(0, -1)) {
    const part = raw.toLowerCase();
    const bit = part === "ctrl" || part === "control" ? 2 :
      part === "alt" || part === "option" ? 1 :
      part === "meta" || part === "cmd" || part === "command" ? 4 :
      part === "shift" ? 8 : 0;
    if (!bit || (modifiers & bit)) throw coded("INVALID_ARGUMENT", "Invalid Chrome keyboard modifier.");
    modifiers |= bit;
  }
  const name = pieces[pieces.length - 1];
  const lookup = {
    Enter: ["Enter", 13], Return: ["Enter", 13], Tab: ["Tab", 9],
    Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46],
    ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40],
    ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
    Space: ["Space", 32],
  };
  const knownName = Object.keys(lookup).find((value) => value.toLowerCase() === name.toLowerCase());
  if (knownName) {
    const [code, keyCode] = lookup[knownName];
    return { key: knownName === "Return" ? "Enter" : knownName === "Space" ? " " : knownName,
      code, keyCode, modifiers, ...(name.toLowerCase() === "enter" && !modifiers ? { text: "\\r" } : {}) };
  }
  if (!/^[a-z0-9]$/iu.test(name)) throw coded("INVALID_ARGUMENT", "Unsupported Chrome key.");
  const upper = name.toUpperCase();
  const isDigit = /^[0-9]$/u.test(name);
  return { key: modifiers & 8 ? upper : name.toLowerCase(),
    code: (isDigit ? "Digit" : "Key") + upper,
    keyCode: upper.charCodeAt(0), modifiers,
    ...(!modifiers ? { text: name } : {}),
  };
}

function waitProbe(text, ref) {
  if (typeof ref === "string" && !globalThis.__mcpV3OwnedRefElements?.get(ref)?.isConnected) return false;
  if (typeof text === "string" && !(document.body?.innerText || "").includes(text)) return false;
  return true;
}

function extractPage(ref, selector, format) {
  let target = document.body;
  if (typeof ref === "string") target = globalThis.__mcpV3OwnedRefElements?.get(ref);
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
  personalViewportSessions.delete(String(tabId));
  void removeOwnedTab(tabId);
});
chrome.debugger?.onDetach?.addListener((source) => {
  const key = String(source?.tabId);
  personalViewportSessions.delete(key);
  const dialog = personalDialogArms.get(key);
  if (dialog) {
    clearTimeout(dialog.timer);
    chrome.debugger.onEvent.removeListener(dialog.listener);
    personalDialogArms.delete(key);
  }
  const capture = personalNetworkCaptures.get(key);
  if (!capture) return;
  capture.active = false;
  personalNetworkCaptures.delete(key);
  chrome.debugger.onEvent.removeListener(capture.listener);
  personalNetworkEntries.set(key, { entries: capture.entries, truncated: true });
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
