import { HANDOFF_EXTENSION_VERSION, HANDOFF_POPUP_HTML, HANDOFF_POPUP_SCRIPT, HANDOFF_WORKER_SOURCE } from "./personal-browser-secret-handoff-assets.js";
import { TAB_SHARING_POPUP_SCRIPT } from "./personal-browser-tab-sharing-assets.js";
import { PLAN_REVIEW_HTML, PLAN_REVIEW_SCRIPT } from "./personal-browser-plan-review-assets.js";
import { TASK_HOME_HTML, TASK_HOME_SCRIPT } from "./personal-browser-task-home-assets.js";
import { summarizeCdpAccessibility } from "./personal-browser-accessibility.js";

export interface PersonalBrowserExtensionAssets {
  manifest: string;
  serviceWorker: string;
  popupHtml: string;
  popupScript: string;
  tabSharingScript: string;
  planReviewHtml: string;
  planReviewScript: string;
  taskHomeHtml: string;
  taskHomeScript: string;
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
  "videoStart", "videoStop", "evaluate", "click", "hover", "drag", "scroll", "fill", "formInput", "type", "press", "sequence", "frameClick", "frameFill", "frameSequence", "navigatePath",
  "goBack", "goForward", "closeTab", "finishTask",
] as const;

export const PERSONAL_BROWSER_CAPABILITIES = [
  "tabs",
  "plan",
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
  "frameExtract",
  "frameClick",
  "frameFill",
  "profilePage",
  "domIndex",
  "frameSequence",
  "navigatePath",
  "sequence",
  "screenshot",
  "console",
  "networkList",
  "networkInspect",
  "pdf",
  "videoStart",
  "videoStop",
  "goBack",
  "goForward",
  "tabGroups",
  "guardedActionsV1",
  "snapshotRevisionV1",
  "frameSequenceMutationsV1",
  "openShadowDomV1",
  "cdpAccessibilityV1",
  "closeTab",
  "finishTask",
  "groupSharingV1",
  "pauseTaskV1",
  "taskMessagesV1",
  "chatWakeV2",
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
    permissions: ["tabs", "scripting", "storage", "debugger", "downloads", "tabGroups", "webNavigation", "notifications",
      "declarativeNetRequest", "alarms"],
    host_permissions: ["http://*/*", "https://*/*"],
    background: { service_worker: "service-worker.js" },
    action: { default_title: "MCP V3 Personal Browser", default_popup: "secret-provision.html" },
    commands: { "fill-mcp-preparation-secret": { suggested_key: { default: "Ctrl+Shift+8" }, description: "Fill the focused MCP prepare-secret field without showing its value" } },
    // Chrome fetches a notification's data: icon under this policy; without
    // data: every chrome.notifications.create call fails.
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' data: ws://127.0.0.1:" + port,
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
const personalTaskDebuggers = new Map();
globalThis.__mcpV3PersonalViewportSessions = personalViewportSessions;
globalThis.__mcpV3PersonalTaskDebuggers = personalTaskDebuggers;
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
  if (session) {
    session.borrowers = (session.borrowers ?? 0) + 1;
    return session;
  }
  const recording = globalThis.__mcpV3PersonalRecordings?.get(key);
  if (!recording) return null;
  recording.borrowers += 1;
  return recording;
}

// Like Claude's own browser tool, a task keeps Chrome's debugger (and its
// "started debugging this browser" bar) on its tab from the first action until
// the task finishes or pauses, the tab leaves the task, the user takes the turn
// or the tab sits idle; an action only borrows it. Without that hold, which the
// worker installs, the action attaches and detaches the debugger itself.
async function attachGuardedDebugger(target) {
  if (borrowPersonalDebugger(target)) return false;
  const held = globalThis.__mcpV3PersonalTaskDebuggers;
  const current = held?.get(String(target.tabId));
  if (current) {
    current.arm();
    return false;
  }
  await chrome.debugger.attach(target, "1.3");
  if (!held) return true;
  holdPersonalTaskDebugger(target.tabId);
  return false;
}

async function detachGuardedDebugger(target, attached) {
  if (attached) {
    await chrome.debugger.detach(target);
    return;
  }
  const key = String(target.tabId);
  globalThis.__mcpV3PersonalTaskDebuggers?.get(key)?.arm();
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
  if (borrowed) {
    borrowed.borrowers = Math.max(0, (borrowed.borrowers ?? 0) - 1);
    return;
  }
  const recording = globalThis.__mcpV3PersonalRecordings?.get(key);
  if (recording) recording.borrowers = Math.max(0, recording.borrowers - 1);
}

const PERSONAL_DEBUGGER_IDLE_MS = 10 * 60 * 1000;

function holdPersonalTaskDebugger(chromeTabId) {
  const key = String(chromeTabId);
  const held = { fresh: true, timer: undefined, arm: () => undefined };
  held.arm = () => {
    clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      if (personalTaskDebuggers.get(key) !== held) return;
      // A call still running may be using it; look again later.
      if (inFlightRequests.size > 0) held.arm();
      else void releasePersonalTaskDebugger(chromeTabId);
    }, PERSONAL_DEBUGGER_IDLE_MS);
  };
  personalTaskDebuggers.set(key, held);
  held.arm();
}

// True once, for the action that attached the task's debugger: Chrome's
// debugging bar has just appeared and resized the page.
function takeFreshPersonalDebugger(target) {
  const held = globalThis.__mcpV3PersonalTaskDebuggers?.get(String(target.tabId));
  if (!held?.fresh) return false;
  held.fresh = false;
  return true;
}

async function releasePersonalTaskDebugger(chromeTabId) {
  const key = String(chromeTabId);
  const held = personalTaskDebuggers.get(key);
  if (!held) return;
  personalTaskDebuggers.delete(key);
  clearTimeout(held.timer);
  // A viewport, dialog, network capture or recording still on the tab takes the
  // debugger over and detaches it when it ends.
  const heir = personalViewportSessions.get(key) ?? personalDialogArms.get(key) ??
    personalNetworkCaptures.get(key) ?? personalRecordings.get(key);
  if (heir) {
    heir.attached = true;
    return;
  }
  await chrome.debugger.detach({ tabId: chromeTabId }).catch(() => undefined);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(BRIDGE_URL);
  socket.onopen = () => {
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: EXTENSION_VERSION,
      browser: "chrome",
      profile: "personal",
      capabilities: CAPABILITIES,
    });
    void pushPersonalSiteApprovals();
    void pushPersonalTaskMessages();
    void pushPersonalWakeSettings();
  };
  socket.onmessage = (event) => {
    void handleMessage(event.data);
  };
  socket.onerror = () => undefined;
  socket.onclose = () => {
    socket = undefined;
    endAllPersonalRecordings();
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
  if (message?.type === "site-approval-request") {
    void recordPersonalApprovalRequest(message).catch(() => undefined);
    return;
  }
  if (message?.type === "task-messages-delivered") {
    void markPersonalTaskMessagesDelivered(message.ids).catch(() => undefined);
    return;
  }
  if (message?.type === "wake-chrome" && typeof message.id === "string") {
    void wakePersonalChatTab(message.text).catch(() => "failed")
      .then((outcome) => send({ type: "wake-chrome-result", id: message.id, outcome }));
    return;
  }
  if (message?.type === "wake-status") {
    void recordPersonalWakeStatus(message.status).catch(() => undefined);
    return;
  }
  if (message?.type === "task-question") {
    void recordPersonalTaskQuestion(message).catch(() => undefined);
    return;
  }
  if (message?.type === "task-messages-external") {
    void recordPersonalExternalTaskMessage(message.message).catch(() => undefined);
    return;
  }
  if (message?.type === "recording-cancel") {
    cancelPersonalRecording(message.recordingId);
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
    await refuseDuringPersonalHandoff(operation, input);
    await refusePausedPersonalTab(operation, input);
    await enforcePersonalPlan(operation, input);
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
    case "frameExtract": return frameExtract(input, signal);
    case "frameClick": return frameClick(input, signal);
    case "frameFill": return frameFill(input, signal);
    case "profilePage": return profilePage(input, signal);
    case "domIndex": return domIndex(input, signal);
    case "frameSequence": return frameSequence(input, signal);
    case "navigatePath": return navigatePath(input, signal);
    case "sequence": return sequence(input, signal, timing);
    case "screenshot": return screenshot(input, signal);
    case "console": return readPersonalConsole(input, signal);
    case "networkList": return readPersonalNetwork(input, signal);
    case "networkInspect": return inspectPersonalNetwork(input, signal);
    case "pdf": return printPersonalPdf(input, signal);
    case "videoStart": return startPersonalRecording(input, signal);
    case "videoStop": return stopPersonalRecording(input, signal);
    case "goBack": return goBack(input, signal);
    case "goForward": return goForward(input, signal);
    case "closeTab": return closeTab(input, signal);
    case "finishTask": return finishTask(input, signal);
    case "plan": return personalPlan(input, signal);
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
    const openTabs = await listPersonalOpenTabs(owned);
    return { tabs: result, ...(openTabs ? { openTabs } : {}) };
  });
}

// Titles and addresses of the user's other tabs, only while the user allows it
// from the popup. Query strings and fragments are dropped, private hosts are
// skipped, and none of these tabs can be controlled until the user shares it.
async function listPersonalOpenTabs(owned) {
  if (!(await personalTabContextEnabled())) return undefined;
  const all = await chrome.tabs.query({}).catch(() => []);
  const openTabs = [];
  for (const tab of all) {
    if (openTabs.length >= 100) break;
    if (!Number.isSafeInteger(tab.id) || owned[String(tab.id)]) continue;
    let url;
    try {
      url = new URL(assertPersonalNavigationTarget(tab.url));
    } catch {
      continue;
    }
    openTabs.push({ url: (url.origin + url.pathname).slice(0, 500), active: tab.active === true,
      ...(typeof tab.title === "string" && tab.title ? { title: tab.title.slice(0, 200) } : {}) });
  }
  return openTabs;
}

const PERSONAL_TAB_CONTEXT_KEY = "mcpV3PersonalTabContext";

async function personalTabContextEnabled() {
  const value = await chrome.storage.session.get(PERSONAL_TAB_CONTEXT_KEY).catch(() => ({}));
  return value?.[PERSONAL_TAB_CONTEXT_KEY] === true;
}

// Only the user shares an already open tab, from the extension popup. A shared
// tab stays the user's: MCP never closes it, and finishing tasks or "Parar de
// compartilhar" only releases it.
async function personalTabSharingDispatch(message) {
  if (["mcp-tab-context", "mcp-tab-notify", "mcp-tab-require-plan", "mcp-tab-confirm-drag"].includes(message.type)) {
    if (typeof message.enabled !== "boolean") throw Error("invalid");
    if (message.type === "mcp-tab-context") {
      await chrome.storage.session.set({ [PERSONAL_TAB_CONTEXT_KEY]: message.enabled });
    } else {
      const key = { "mcp-tab-notify": PERSONAL_NOTIFY_ON_FINISH_KEY, "mcp-tab-require-plan": PERSONAL_REQUIRE_PLAN_KEY,
        "mcp-tab-confirm-drag": PERSONAL_CONFIRM_DRAG_KEY }[message.type];
      await chrome.storage.local.set({ [key]: message.enabled });
    }
  }
  if (!Number.isSafeInteger(message.tabId)) throw Error("no-tab");
  const tab = await chrome.tabs.get(message.tabId);
  const pendingShare = await readPendingPersonalShare(tab.id);
  if (pendingShare && (message.type === "mcp-tab-share" || message.type === "mcp-tab-unshare")) {
    await answerPersonalShare(tab.id, message.type === "mcp-tab-share");
  } else if (message.type === "mcp-tab-share") {
    // A tab shared from the popup gets an MCP group of its own: tabs dragged
    // into that group are shared too. The group is not a task, so its tabs keep
    // their approvals while they stay shared, as before.
    const groupKey = PERSONAL_POPUP_SHARE_PREFIX + crypto.randomUUID();
    const url = await withOwnershipLock(async () => {
      const owned = await readOwnedTabs();
      if (owned[String(tab.id)]) throw Error("already-owned");
      const current = await chrome.tabs.get(tab.id);
      const sharedUrl = assertPersonalNavigationTarget(current.url);
      const now = new Date().toISOString();
      owned[String(tab.id)] = {
        tabId: PERSONAL_PREFIX + tab.id, lifecycle: "external", ownership: "user",
        purpose: "Aba compartilhada pelo usuário", reusable: false, protected: true, sticky: false,
        createdAt: now, lastUsedAt: now, requestedUrl: sharedUrl,
      };
      await writeOwnedTabs(owned);
      return sharedUrl;
    });
    await setPersonalSharedBadge(tab.id, true);
    pendingMcpTabs.add(tab.id);
    try {
      const groupId = await assignMcpTaskGroup(tab.id, groupKey, {}, url);
      if (Number.isInteger(groupId)) await attachSharedTabToTask(tab.id, groupKey, groupId);
    } finally {
      pendingMcpTabs.delete(tab.id);
    }
  } else if (message.type === "mcp-tab-unshare") {
    const owned = await readOwnedTabs();
    const metadata = owned[String(tab.id)];
    if (metadata?.ownership !== "user") throw Error("not-shared");
    await releasePersonalSharedTab(tab.id);
    // Leaving its MCP group undoes a group the share started; Chrome drops an empty group.
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (current && Number.isInteger(metadata.mcpGroupId) && current.groupId === metadata.mcpGroupId) {
      await chrome.tabs.ungroup(tab.id).catch(() => undefined);
    }
  } else if (message.type === "mcp-tab-resume") {
    if (!(await resumePersonalHandoff(tab.id))) throw Error("not-waiting");
  } else if (message.type === "mcp-tab-message") {
    // "Enviar e devolver": the note goes first, so it reaches the browser_wait that is waiting for the tab.
    const handoff = message.resume === true ? await readPersonalHandoff(tab.id) : undefined;
    if (message.resume === true && (!handoff || handoff.done)) throw Error("not-waiting");
    await sendPersonalTaskMessage(tab.id, message.text);
    if (message.resume === true) await resumePersonalHandoff(tab.id);
  } else if (message.type === "mcp-tab-wake") {
    await setPersonalWakeEnabled(message.enabled);
  } else if (message.type === "mcp-tab-approve") {
    if (!(await grantPersonalSiteApproval(tab.id))) throw Error("not-requested");
  } else if (message.type === "mcp-tab-revoke") {
    const origin = new URL(tab.url).origin;
    await withPersonalSiteGrants(() => changePersonalSiteGrants((grants) => grants.filter((grant) => grant.origin !== origin)));
  } else if (message.type === "mcp-tab-auto") {
    if (typeof message.enabled !== "boolean") throw Error("invalid");
    const host = new URL(assertPersonalNavigationTarget(tab.url)).hostname;
    const sites = (await readPersonalAutoSites()).filter((site) => site !== host);
    if (message.enabled) sites.push(host);
    await chrome.storage.local.set({ [PERSONAL_AUTO_SITES_KEY]: sites.sort() });
    await pushPersonalSiteApprovals();
  } else if (!["mcp-tab-status", "mcp-tab-context", "mcp-tab-notify", "mcp-tab-require-plan", "mcp-tab-confirm-drag"]
    .includes(message.type)) {
    throw Error("unsupported");
  }
  const owned = await readOwnedTabs();
  const metadata = owned[String(tab.id)];
  let shareable = false;
  try {
    assertPersonalNavigationTarget(tab.url);
    shareable = !metadata;
  } catch {
    shareable = false;
  }
  const handoff = metadata ? await readPersonalHandoff(tab.id) : undefined;
  const waiting = handoff && !handoff.done ? handoff.reason : undefined;
  const notify = (await chrome.storage.local.get(PERSONAL_NOTIFY_ON_FINISH_KEY).catch(() => ({})))?.[PERSONAL_NOTIFY_ON_FINISH_KEY] === true;
  return { ok: true, shared: metadata?.ownership === "user", mcp: metadata?.ownership === "mcp",
    shareable, context: await personalTabContextEnabled(), notify, requirePlan: await personalPlanRequired(),
    confirmDrag: await personalDragShareNeedsConfirmation(),
    ...(await readPendingPersonalShare(tab.id) ? { pendingShare: (await readPendingPersonalShare(tab.id)).title } : {}),
    ...(waiting ? { waiting } : {}), ...(await personalApprovalStatus(tab)),
    inbox: await personalTaskInboxStatus(tab.id), wake: await personalWakeStatus() };
}

// What the popup shows about approvals for the site of the current tab.
async function personalApprovalStatus(tab) {
  let url;
  try {
    url = new URL(assertPersonalNavigationTarget(tab.url));
  } catch {
    return { autoEligible: false, auto: false, grants: [], autoSites: await readPersonalAutoSites() };
  }
  const request = await readPersonalApprovalRequest(tab.id);
  const autoSites = await readPersonalAutoSites();
  return {
    autoEligible: true, auto: autoSites.includes(url.hostname), autoSites,
    grants: [...new Set((await readPersonalSiteGrants()).filter((grant) => grant.origin === url.origin)
      .map((grant) => grant.category + " " + (typeof grant.taskId === "string" ? "task" : "tab")))]
      .map((key) => ({ category: key.split(" ")[0], until: key.split(" ")[1] })),
    ...(request?.origin === url.origin ? { approval: request.category } : {}),
  };
}

const PERSONAL_SITE_GRANTS_KEY = "mcpV3SiteGrants";
const PERSONAL_AUTO_SITES_KEY = "mcpV3AutoApproveSites";
const PERSONAL_APPROVAL_REQUEST_PREFIX = "mcpV3ApprovalRequest:";
// Deleting, paying, sending, publishing, credentials and contracts are never
// approved per site: each one keeps its own confirmation.
const PERSONAL_APPROVAL_LABELS = {
  "submit-form": "Salvar e confirmar formulários",
  "upload-file": "Enviar arquivos",
  "execute-script": "Executar JavaScript",
};

async function readPersonalSiteGrants() {
  const value = await chrome.storage.session.get(PERSONAL_SITE_GRANTS_KEY).catch(() => ({}));
  const grants = Array.isArray(value?.[PERSONAL_SITE_GRANTS_KEY]) ? value[PERSONAL_SITE_GRANTS_KEY] : [];
  return grants.filter((grant) => grant && typeof grant.origin === "string" && typeof grant.category === "string" &&
    typeof grant.tabId === "string");
}

async function writePersonalSiteGrants(grants) {
  await chrome.storage.session.set({ [PERSONAL_SITE_GRANTS_KEY]: grants });
  await pushPersonalSiteApprovals();
}

// Requests, grants and their clean-ups run one at a time, so a click and a
// clean-up never overwrite each other or revive a request.
let personalSiteGrantsQueue = Promise.resolve();
function withPersonalSiteGrants(task) {
  const next = personalSiteGrantsQueue.then(task);
  personalSiteGrantsQueue = next.catch(() => undefined);
  return next;
}

async function changePersonalSiteGrants(change) {
  const grants = await readPersonalSiteGrants();
  const updated = change(grants);
  if (updated.length !== grants.length || updated.some((grant, index) => grant !== grants[index])) {
    await writePersonalSiteGrants(updated);
  }
}

async function readPersonalAutoSites() {
  const value = await chrome.storage.local.get(PERSONAL_AUTO_SITES_KEY).catch(() => ({}));
  const sites = value?.[PERSONAL_AUTO_SITES_KEY];
  return Array.isArray(sites) ? sites.filter((site) => typeof site === "string") : [];
}

// The bridge learns approvals only from here and never grants one itself.
async function pushPersonalSiteApprovals() {
  const grants = await readPersonalSiteGrants();
  send({
    type: "site-approvals",
    grants: grants.map((grant) => ({ origin: grant.origin, category: grant.category,
      ...(typeof grant.taskId === "string" ? { taskId: grant.taskId } : { tabId: grant.tabId }) })),
    autoSites: await readPersonalAutoSites(),
  });
}

async function readPersonalApprovalRequest(chromeTabId) {
  const key = PERSONAL_APPROVAL_REQUEST_PREFIX + chromeTabId;
  const value = await chrome.storage.session.get(key).catch(() => ({}));
  return value?.[key];
}

async function clearPersonalApprovalRequest(chromeTabId) {
  await chrome.storage.session.remove(PERSONAL_APPROVAL_REQUEST_PREFIX + chromeTabId).catch(() => undefined);
  await Promise.resolve(chrome.notifications?.clear?.("mcp-approval:" + chromeTabId)).catch(() => undefined);
}

// The bridge asks after it refused an action. The request is recorded only
// for an MCP or shared tab still on that origin, with the tab's own task, and
// the user answers from the notification or the popup. There is no time
// limit: a grant lasts until its task ends or, for a tab without a task, until
// that tab leaves MCP.
function recordPersonalApprovalRequest(message) {
  return withPersonalSiteGrants(async () => {
    if (!Object.hasOwn(PERSONAL_APPROVAL_LABELS, message.category) || typeof message.origin !== "string") return;
    const chromeTabId = chromeTabIdFrom(message.tabId);
    const metadata = (await readOwnedTabs())[String(chromeTabId)];
    const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
    if (!metadata || !tab) return;
    const origin = new URL(tab.url).origin;
    if (origin !== message.origin) return;
    const taskId = typeof metadata.taskId === "string" ? metadata.taskId : undefined;
    await chrome.storage.session.set({ [PERSONAL_APPROVAL_REQUEST_PREFIX + chromeTabId]: {
      origin, category: message.category, ...(taskId ? { taskId } : {}), requestedAt: Date.now(),
    } });
    await Promise.resolve(chrome.notifications?.create?.("mcp-approval:" + chromeTabId, {
      type: "basic", iconUrl: PERSONAL_NOTIFICATION_ICON, title: "O MCP pede permissão em " + new URL(origin).host,
      message: PERSONAL_APPROVAL_LABELS[message.category] + ". Permitir libera isso neste site " +
        (taskId ? "até o fim da tarefa." : "enquanto esta aba estiver com o MCP."),
      buttons: [{ title: "Permitir neste site" }], requireInteraction: true, priority: 1,
    })).catch(() => undefined);
  });
}

function grantPersonalSiteApproval(chromeTabId) {
  return withPersonalSiteGrants(async () => {
    const request = await readPersonalApprovalRequest(chromeTabId);
    await clearPersonalApprovalRequest(chromeTabId);
    if (!request) return false;
    const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
    let origin;
    try {
      origin = new URL(tab?.url).origin;
    } catch {
      return false;
    }
    // The tab left that site, or MCP no longer holds it in that task: nothing is granted.
    const metadata = (await readOwnedTabs())[String(chromeTabId)];
    if (origin !== request.origin || !metadata || metadata.taskId !== request.taskId) return false;
    const grant = { origin, category: request.category, tabId: PERSONAL_PREFIX + chromeTabId,
      ...(request.taskId ? { taskId: request.taskId } : {}), grantedAt: Date.now() };
    const owner = (candidate) => typeof candidate.taskId === "string" ? "task:" + candidate.taskId : "tab:" + candidate.tabId;
    await changePersonalSiteGrants((grants) => [...grants.filter((candidate) => candidate.origin !== origin ||
      candidate.category !== grant.category || owner(candidate) !== owner(grant)), grant]);
    return true;
  });
}

// Approvals given for a task end with it, as do those of its tabs that have
// no task; requests on its tabs are dropped.
function clearPersonalTaskApprovals(taskId, chromeTabIds) {
  return withPersonalSiteGrants(async () => {
    for (const chromeTabId of chromeTabIds) await clearPersonalApprovalRequest(chromeTabId);
    const tabIds = chromeTabIds.map((chromeTabId) => PERSONAL_PREFIX + chromeTabId);
    await changePersonalSiteGrants((grants) => grants.filter((grant) => typeof grant.taskId === "string"
      ? taskId !== undefined && grant.taskId !== taskId
      : !tabIds.includes(grant.tabId)));
  });
}

// A tab without a task keeps its approvals only while it stays with MCP.
function clearPersonalTabApprovals(chromeTabId) {
  return withPersonalSiteGrants(async () => {
    await clearPersonalApprovalRequest(chromeTabId);
    await changePersonalSiteGrants((grants) => grants.filter((grant) => typeof grant.taskId === "string" ||
      grant.tabId !== PERSONAL_PREFIX + chromeTabId));
  });
}

async function releasePersonalSharedTab(chromeTabId) {
  await finalizePersonalDialog(chromeTabId, true);
  await resetPersonalViewport(chromeTabId).catch(() => undefined);
  await removeOwnedTab(chromeTabId);
  await clearPersonalHandoff(chromeTabId);
  await clearPersonalTabApprovals(chromeTabId);
  await setPersonalSharedBadge(chromeTabId, false);
}

async function setPersonalSharedBadge(chromeTabId, shared) {
  await Promise.resolve(chrome.action?.setBadgeBackgroundColor?.({ tabId: chromeTabId, color: "#2563eb" }))
    .catch(() => undefined);
  await Promise.resolve(chrome.action?.setBadgeText?.({ tabId: chromeTabId, text: shared ? "MCP" : "" }))
    .catch(() => undefined);
}

const PERSONAL_HANDOFF_PREFIX = "mcpV3PersonalHandoff:";
const PERSONAL_NOTIFY_ON_FINISH_KEY = "mcpV3NotifyOnFinish";
const PERSONAL_NOTIFICATION_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAl0lEQVR42u3ayw2AMAwE0ZxomVqpBipACeRj72YscZ93A5tSGKO5zuNueSSj02F6w8Mgo8OXQmbHT0OsCp8CiYofgoiO70ZIA7LE/0Jki/+MkAZkjW9GSAOyx1cRACIBKvGvCAAAAAAAAEAawLsQgE2+Cfw/KdlKsBsy3M7tu9yVX69bHDgsTkw2Rz6LM6vNodvmVwOmcx4kG+wc6mPGcQAAAABJRU5ErkJggg==";

async function readPersonalHandoff(chromeTabId) {
  const key = PERSONAL_HANDOFF_PREFIX + chromeTabId;
  const value = await chrome.storage.session.get(key).catch(() => ({}));
  const handoff = value?.[key];
  return handoff && typeof handoff.reason === "string" ? handoff : undefined;
}

// While the user has the turn in a tab, MCP neither reads nor acts in it. Once
// they hand it back, the next MCP call consumes that answer.
async function refuseDuringPersonalHandoff(operation, input) {
  // A recording can always stop; it records nothing during the user's turn.
  if (typeof input?.tabId !== "string" || operation === "videoStop" ||
      (operation === "wait" && typeof input.forUser === "string")) return;
  let chromeTabId;
  try {
    chromeTabId = chromeTabIdFrom(input.tabId);
  } catch {
    return;
  }
  const handoff = await readPersonalHandoff(chromeTabId);
  if (handoff?.done) await clearPersonalHandoff(chromeTabId);
  else if (handoff) {
    throw coded("EXECUTION_STATE_INVALID", "The user has the turn in this tab (" + handoff.reason +
      "). Call browser_wait with forUser to wait until they hand it back.");
  }
}

// Hands an owned or shared tab to the user for a login, a CAPTCHA or a choice
// only they should make, and waits until they click "Pronto, pode continuar" in
// the popup or the notification. The turn is not handed back on a timeout.
async function waitForUser(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId, true);
  let handoff = await readPersonalHandoff(chromeTabId);
  if (handoff?.done) {
    // Handed back after an earlier call timed out.
    await clearPersonalHandoff(chromeTabId);
    return { tabId: input.tabId, completed: true };
  }
  if (!handoff) {
    // The user's turn runs without MCP's debugger on the tab.
    await releasePersonalTaskDebugger(chromeTabId);
    handoff = { reason: String(input.forUser).slice(0, 200), startedAt: Date.now() };
    await chrome.storage.session.set({ [PERSONAL_HANDOFF_PREFIX + chromeTabId]: handoff });
    await Promise.resolve(chrome.action?.setBadgeBackgroundColor?.({ tabId: chromeTabId, color: "#d97706" }))
      .catch(() => undefined);
    await Promise.resolve(chrome.action?.setBadgeText?.({ tabId: chromeTabId, text: "VOCÊ" })).catch(() => undefined);
    await Promise.resolve(chrome.notifications?.create?.("mcp-handoff:" + chromeTabId, {
      type: "basic", iconUrl: PERSONAL_NOTIFICATION_ICON, title: "O MCP precisa de você",
      message: handoff.reason, buttons: [{ title: "Pronto, pode continuar" }], requireInteraction: true, priority: 2,
    })).catch(() => undefined);
  }
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1, Math.min(120000, input.timeoutMs)) : 50000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
    const current = await readPersonalHandoff(chromeTabId);
    if (!current || current.done) {
      // Without a record the user stopped sharing or the task ended meanwhile.
      if (!current) await requireOwnedMetadata(chromeTabId, true);
      await clearPersonalHandoff(chromeTabId);
      return { tabId: input.tabId, completed: true };
    }
  }
  throw coded("STATE_NOT_REACHED", "The user has not handed the tab back yet (" + handoff.reason +
    "). Call browser_wait with forUser again to keep waiting.");
}

// The user hands the tab back; the answer waits for MCP's next call.
async function resumePersonalHandoff(chromeTabId) {
  const handoff = await readPersonalHandoff(chromeTabId);
  if (!handoff || handoff.done) return false;
  await chrome.storage.session.set({ [PERSONAL_HANDOFF_PREFIX + chromeTabId]: { ...handoff, done: true } });
  await settlePersonalHandoffSignals(chromeTabId);
  send({ type: "wake-event", kind: "handback", tabId: PERSONAL_PREFIX + chromeTabId,
    ...(typeof handoff.reason === "string" ? { reason: handoff.reason } : {}) });
  return true;
}

async function clearPersonalHandoff(chromeTabId) {
  const existed = Boolean(await readPersonalHandoff(chromeTabId));
  await chrome.storage.session.remove(PERSONAL_HANDOFF_PREFIX + chromeTabId).catch(() => undefined);
  if (existed) await settlePersonalHandoffSignals(chromeTabId);
}

async function settlePersonalHandoffSignals(chromeTabId) {
  await Promise.resolve(chrome.notifications?.clear?.("mcp-handoff:" + chromeTabId)).catch(() => undefined);
  const owned = await readOwnedTabs().catch(() => ({}));
  await setPersonalSharedBadge(chromeTabId, owned[String(chromeTabId)]?.ownership === "user");
}

async function notifyPersonalTaskFinished(taskId, closed, released) {
  const value = await chrome.storage.local.get(PERSONAL_NOTIFY_ON_FINISH_KEY).catch(() => ({}));
  if (value?.[PERSONAL_NOTIFY_ON_FINISH_KEY] !== true || closed + released === 0) return;
  await Promise.resolve(chrome.notifications?.create?.("mcp-finished:" + Date.now(), {
    type: "basic", iconUrl: PERSONAL_NOTIFICATION_ICON, title: "O MCP terminou uma tarefa",
    message: (taskId ? "Tarefa " + String(taskId).slice(0, 80) + ": " : "") + closed + " aba(s) fechada(s), " +
      released + " devolvida(s) a você.",
    priority: 0,
  })).catch(() => undefined);
}

// Messages the user writes in the popup for a running task. They stay here
// until the bridge says the agent received them, and go out again after every
// reconnect, so a message is never lost while MCP V3 restarts.
const PERSONAL_TASK_MESSAGES_KEY = "mcpV3TaskMessages";
const PERSONAL_TASK_QUESTIONS_KEY = "mcpV3TaskQuestions";
const PERSONAL_TASK_MESSAGE_LIMIT = 50;
const PERSONAL_TASK_QUESTION_TTL_MS = 30 * 60 * 1000;
const personalTaskMessageQueue = { tail: Promise.resolve() };

function withPersonalTaskMessages(work) {
  const current = personalTaskMessageQueue.tail.then(work);
  personalTaskMessageQueue.tail = current.then(() => undefined, () => undefined);
  return current;
}

async function readPersonalTaskMessages() {
  const value = await chrome.storage.local.get(PERSONAL_TASK_MESSAGES_KEY).catch(() => ({}));
  const messages = value?.[PERSONAL_TASK_MESSAGES_KEY];
  return Array.isArray(messages) ? messages.filter((entry) => typeof entry?.id === "string" && typeof entry.text === "string") : [];
}

async function writePersonalTaskMessages(messages) {
  await chrome.storage.local.set({ [PERSONAL_TASK_MESSAGES_KEY]: messages.slice(-PERSONAL_TASK_MESSAGE_LIMIT) });
}

async function readPersonalTaskQuestions() {
  const value = await chrome.storage.session.get(PERSONAL_TASK_QUESTIONS_KEY).catch(() => ({}));
  const questions = value?.[PERSONAL_TASK_QUESTIONS_KEY];
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(questions).filter(([, entry]) =>
    typeof entry?.question === "string" && Number.isFinite(entry.askedAt) && now - entry.askedAt < PERSONAL_TASK_QUESTION_TTL_MS));
}

async function pushPersonalTaskMessages() {
  const pending = (await readPersonalTaskMessages()).filter((entry) => !entry.deliveredAt);
  if (pending.length === 0) return;
  send({ type: "task-messages", messages: pending.map(({ id, text, sentAt, taskId, tabIds }) =>
    ({ id, text, sentAt, ...(typeof taskId === "string" ? { taskId } : {}), tabIds: Array.isArray(tabIds) ? tabIds : [] })) });
}

async function markPersonalTaskMessagesDelivered(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const delivered = new Set(ids.filter((id) => typeof id === "string"));
  await withPersonalTaskMessages(async () => {
    const now = new Date().toISOString();
    const messages = await readPersonalTaskMessages();
    await writePersonalTaskMessages(messages.map((entry) =>
      delivered.has(entry.id) && !entry.deliveredAt ? { ...entry, deliveredAt: now } : entry));
  });
}

// The agent asks without ending its turn; the popup shows the question until the user answers.
async function recordPersonalTaskQuestion(message) {
  if (typeof message.taskId !== "string" || !message.taskId || message.taskId.length > 128 ||
      typeof message.question !== "string" || !message.question.trim()) return;
  const question = message.question.trim().slice(0, 500);
  const questions = await readPersonalTaskQuestions();
  questions[message.taskId] = { question, askedAt: Date.now() };
  await chrome.storage.session.set({ [PERSONAL_TASK_QUESTIONS_KEY]: questions });
  await Promise.resolve(chrome.action?.setBadgeBackgroundColor?.({ color: "#2563eb" })).catch(() => undefined);
  await Promise.resolve(chrome.action?.setBadgeText?.({ text: "?" })).catch(() => undefined);
  await Promise.resolve(chrome.notifications?.create?.("mcp-question:" + Date.now(), {
    type: "basic", iconUrl: PERSONAL_NOTIFICATION_ICON, title: "O MCP tem uma pergunta",
    message: question + " Responda no ChatGPT ou pelo ícone da extensão MCP V3.", requireInteraction: true, priority: 2,
  })).catch(() => undefined);
}

async function clearPersonalTaskQuestion(taskId) {
  const questions = await readPersonalTaskQuestions();
  const remaining = taskId === undefined ? {} : { ...questions };
  if (taskId !== undefined) delete remaining[taskId];
  if (Object.keys(remaining).length === Object.keys(questions).length) return;
  await chrome.storage.session.set({ [PERSONAL_TASK_QUESTIONS_KEY]: remaining });
  if (Object.keys(remaining).length === 0) {
    await Promise.resolve(chrome.action?.setBadgeText?.({ text: "" })).catch(() => undefined);
  }
}

// A popup message goes to the task of the current tab; otherwise to the task
// that asked the latest open question, or else the task MCP used last.
async function personalTaskMessageTarget(chromeTabId) {
  const owned = await readOwnedTabs().catch(() => ({}));
  const entries = Object.values(owned).filter((entry) => typeof entry?.taskId === "string" && entry.taskId);
  let taskId = Number.isSafeInteger(chromeTabId) ? owned[String(chromeTabId)]?.taskId : undefined;
  const questions = await readPersonalTaskQuestions();
  if (typeof taskId !== "string" || !taskId) {
    const asked = Object.entries(questions).sort(([, left], [, right]) => right.askedAt - left.askedAt)[0];
    taskId = asked?.[0];
  }
  if (typeof taskId !== "string" || !taskId) {
    const latest = entries.filter((entry) => entry.ownership === "mcp")
      .sort((left, right) => String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)))[0];
    taskId = latest?.taskId;
  }
  if (typeof taskId !== "string" || !taskId) return { tabIds: [] };
  const tabs = entries.filter((entry) => entry.taskId === taskId);
  const purpose = tabs.find((entry) => entry.ownership === "mcp" && typeof entry.purpose === "string")?.purpose;
  return { taskId, tabIds: tabs.map((entry) => entry.tabId).filter((tabId) => typeof tabId === "string"),
    ...(typeof purpose === "string" ? { label: purpose.slice(0, 80) } : {}),
    ...(questions[taskId] ? { question: questions[taskId].question } : {}) };
}

async function sendPersonalTaskMessage(chromeTabId, text) {
  const value = typeof text === "string" ? text.trim().slice(0, 2000) : "";
  if (!value) throw Error("empty");
  const target = await personalTaskMessageTarget(chromeTabId);
  const message = { id: "msg_" + crypto.randomUUID(), text: value, sentAt: new Date().toISOString(),
    ...(target.taskId ? { taskId: target.taskId } : {}), tabIds: target.tabIds };
  await withPersonalTaskMessages(async () => {
    await writePersonalTaskMessages([...(await readPersonalTaskMessages()), message]);
  });
  if (target.taskId) await clearPersonalTaskQuestion(target.taskId);
  await pushPersonalTaskMessages();
}

// A message the user wrote in the reply card in the ChatGPT conversation. The
// bridge already holds it; the popup shows it like its own, and it answers
// the task's open question.
async function recordPersonalExternalTaskMessage(raw) {
  if (typeof raw?.id !== "string" || !/^msg_[a-z0-9-]{8,64}$/u.test(raw.id) ||
      typeof raw.text !== "string" || !raw.text.trim() || typeof raw.sentAt !== "string") return;
  const taskId = typeof raw.taskId === "string" && raw.taskId && raw.taskId.length <= 128 ? raw.taskId : undefined;
  const message = { id: raw.id, text: raw.text.slice(0, 2000), sentAt: raw.sentAt,
    ...(taskId ? { taskId } : {}), tabIds: [], source: "chat" };
  const added = await withPersonalTaskMessages(async () => {
    const messages = await readPersonalTaskMessages();
    if (messages.some((entry) => entry.id === message.id)) return false;
    await writePersonalTaskMessages([...messages, message]);
    return true;
  });
  if (!added) return;
  await clearPersonalTaskQuestion(taskId);
}

// What the popup shows: where a message goes, an open question, and the latest messages.
async function personalTaskInboxStatus(chromeTabId) {
  const target = await personalTaskMessageTarget(chromeTabId);
  const recent = (await readPersonalTaskMessages())
    .filter((entry) => !target.taskId || entry.taskId === target.taskId || entry.taskId === undefined)
    .slice(-5)
    .map((entry) => ({ text: entry.text, sentAt: entry.sentAt, delivered: typeof entry.deliveredAt === "string" }));
  return { ...(target.taskId ? { task: target.label ?? target.taskId } : {}),
    ...(target.question ? { question: target.question } : {}), recent };
}

// The companion wakes the ChatGPT conversation by itself (see chat-wake.ts):
// the ChatGPT app for Windows first and, without it, the ChatGPT tab the user
// used last, which only the extension can reach. The popup switch lives here
// and goes to the companion on every connect; the companion sends back what it
// did. Only the companion's own words go into the tab, nothing from a page.
const PERSONAL_WAKE_KEY = "mcpV3ChatWake";
const PERSONAL_WAKE_URLS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const PERSONAL_WAKE_HOSTS = ["chatgpt.com", "chat.openai.com"];

async function readPersonalWake() {
  const value = (await chrome.storage.local.get(PERSONAL_WAKE_KEY).catch(() => ({})))?.[PERSONAL_WAKE_KEY];
  return value && typeof value === "object" ? value : {};
}

function isPersonalWakeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" && PERSONAL_WAKE_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

// The ChatGPT tab the user used last; a tab shared with MCP is never one.
async function personalWakeTargetTab() {
  const tabs = await chrome.tabs.query({ url: PERSONAL_WAKE_URLS }).catch(() => []);
  const owned = await readOwnedTabs().catch(() => ({}));
  return tabs.filter((tab) => Number.isSafeInteger(tab.id) && !owned[String(tab.id)] && isPersonalWakeUrl(tab.url))
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
}

async function setPersonalWakeEnabled(enabled) {
  if (typeof enabled !== "boolean") throw Error("invalid");
  const state = await readPersonalWake();
  await chrome.storage.local.set({ [PERSONAL_WAKE_KEY]: { ...state, disabled: !enabled,
    status: { ...(state.status ?? {}), enabled, ...(enabled ? {} : { waiting: 0, lastError: undefined }) } } });
  sendPersonalWakeSettings(enabled);
}

function sendPersonalWakeSettings(enabled) {
  send({ type: "wake-settings", enabled });
}

async function pushPersonalWakeSettings() {
  sendPersonalWakeSettings((await readPersonalWake()).disabled !== true);
}

async function recordPersonalWakeStatus(status) {
  if (!status || typeof status !== "object") return;
  const state = await readPersonalWake();
  await chrome.storage.local.set({ [PERSONAL_WAKE_KEY]: { ...state, status: {
    waiting: Number.isSafeInteger(status.waiting) ? status.waiting : 0,
    ...(typeof status.lastError === "string" ? { lastError: status.lastError.slice(0, 200) } : {}),
    recent: Array.isArray(status.recent) ? status.recent.slice(-3) : [] } } });
}

// Runs in the ChatGPT tab: is the conversation idle, and can the notice go in?
function personalWakeInspect(text) {
  const busy = Boolean(document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Parar"]'));
  const composer = document.querySelector("#prompt-textarea") ||
    document.querySelector('form [contenteditable="true"]') || document.querySelector("form textarea");
  if (!composer) return { state: "no-composer" };
  const current = "value" in composer ? composer.value : composer.innerText;
  if (busy) return { state: "busy" };
  if (String(current || "").trim()) return { state: "typing" };
  if (typeof text !== "string") return { state: "idle" };
  composer.focus();
  if ("value" in composer) {
    composer.value = text;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("insertText", false, text);
  }
  return new Promise((resolve) => {
    let tries = 0;
    const press = () => {
      const button = document.querySelector('[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send"], button[aria-label*="Enviar"]');
      if (button && !button.disabled) {
        button.click();
        resolve({ state: "sent" });
      } else if (++tries > 20) {
        resolve({ state: "no-send-button" });
      } else {
        setTimeout(press, 100);
      }
    };
    press();
  });
}

// The companion asks to write the notice in the ChatGPT tab used last.
async function wakePersonalChatTab(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000) return "failed";
  const tab = await personalWakeTargetTab();
  if (!tab) return "unavailable";
  const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
    func: personalWakeInspect, args: [text] }).catch(() => []);
  const outcome = injected?.result?.state;
  return ["sent", "busy", "typing"].includes(outcome) ? outcome : "failed";
}

// What the popup shows about waking ChatGPT.
async function personalWakeStatus() {
  const state = await readPersonalWake();
  const status = state.status ?? {};
  return { enabled: state.disabled !== true, waiting: Number.isSafeInteger(status.waiting) ? status.waiting : 0,
    ...(typeof status.lastError === "string" ? { lastError: status.lastError } : {}),
    recent: Array.isArray(status.recent) ? status.recent : [] };
}

const PERSONAL_PLANS_KEY = "mcpV3PersonalPlans";
const PERSONAL_REQUIRE_PLAN_KEY = "mcpV3RequirePlan";
const PERSONAL_PLAN_ACTIONS = ["navigate", "interact", "fill", "upload", "download", "evaluate"];
const PERSONAL_PLAN_CATEGORIES = {
  open: "navigate", navigate: "navigate", goBack: "navigate", goForward: "navigate",
  snapshot: "read", find: "read", extract: "read", frameExtract: "read", profilePage: "read", domIndex: "read",
  screenshot: "read", console: "read", networkList: "read", networkInspect: "read", pdf: "read", videoStart: "read",
  click: "interact", hover: "interact", drag: "interact", scroll: "interact", press: "interact",
  frameClick: "interact", navigatePath: "interact",
  fill: "fill", formInput: "fill", type: "fill", frameFill: "fill",
  upload: "upload", download: "download", evaluate: "evaluate",
};
const PERSONAL_PLAN_STEP_CATEGORIES = {
  navigate: "navigate", click: "interact", hover: "interact", scroll: "interact", drag: "interact", press: "interact",
  fill: "fill", formInput: "fill", type: "fill", select: "fill",
  wait: "read", extract: "read", index: "read", assert: "read", waitFor: "read",
};
let personalPlanTail = Promise.resolve();

function withPersonalPlanLock(callback) {
  const run = personalPlanTail.then(callback, callback);
  personalPlanTail = run.catch(() => undefined);
  return run;
}

async function readPersonalPlans() {
  const value = await chrome.storage.session.get(PERSONAL_PLANS_KEY).catch(() => ({}));
  const plans = value?.[PERSONAL_PLANS_KEY];
  return plans && typeof plans === "object" ? plans : {};
}

async function writePersonalPlans(plans) {
  await chrome.storage.session.set({ [PERSONAL_PLANS_KEY]: plans });
}

async function personalPlanRequired() {
  const value = await chrome.storage.local.get(PERSONAL_REQUIRE_PLAN_KEY).catch(() => ({}));
  return value?.[PERSONAL_REQUIRE_PLAN_KEY] === true;
}

function personalPlanResult(plan) {
  const approved = plan.status === "approved";
  return {
    planId: plan.planId, taskId: plan.taskId, status: plan.status,
    domains: approved ? plan.approvedDomains : plan.domains,
    actions: approved ? plan.approvedActions : plan.actions,
    ...(plan.tabIds.length > 0 ? { tabIds: plan.tabIds } : {}),
    ...(plan.feedback ? { feedback: plan.feedback } : {}),
  };
}

// Shows the plan in a Chrome window of its own and waits for the user. Only a
// click in that window decides it; MCP can only propose or keep waiting.
async function personalPlan(input, signal) {
  const planId = typeof input.planId === "string" ? input.planId : await proposePersonalPlan(input);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1, Math.min(120000, input.timeoutMs)) : 50000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const plan = (await readPersonalPlans())[planId];
    if (!plan) {
      throw coded("EXECUTION_NOT_FOUND", "Plan " + planId +
        " no longer exists: its task finished or Chrome restarted. Propose a new plan with browser_plan.");
    }
    if (plan.status !== "pending" || Date.now() >= deadline) return personalPlanResult(plan);
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
  }
}

async function proposePersonalPlan(input) {
  const domains = [...new Set(input.domains.map((domain) => String(domain).trim().toLowerCase().replace(/\\.$/u, "")))];
  const actions = PERSONAL_PLAN_ACTIONS.filter((action) => input.actions.includes(action));
  const tabIds = Array.isArray(input.tabIds) ? input.tabIds : [];
  const tabs = [];
  for (const tabId of tabIds) {
    const chromeTabId = chromeTabIdFrom(tabId);
    await requireOwnedMetadata(chromeTabId);
    const tab = await chrome.tabs.get(chromeTabId);
    tabs.push(String(tab.title || new URL(tab.url).hostname).slice(0, 120));
  }
  const planId = "plan_" + crypto.randomUUID();
  const now = Date.now();
  const superseded = await withPersonalPlanLock(async () => {
    const plans = await readPersonalPlans();
    const replaced = [];
    for (const plan of Object.values(plans)) {
      if (plan.status === "pending" && plan.taskId === input.taskId) {
        plan.status = "superseded";
        plan.decidedAt = now;
        replaced.push(plan);
      } else if (plan.status !== "pending" && plan.status !== "approved" && now - (plan.decidedAt ?? 0) > 1800000) {
        delete plans[plan.planId];
      }
    }
    plans[planId] = {
      planId, taskId: input.taskId, summary: String(input.summary).slice(0, 500),
      steps: input.steps.map((step) => String(step).slice(0, 200)).slice(0, 20),
      domains, actions, tabIds, tabs, status: "pending", createdAt: now,
    };
    await writePersonalPlans(plans);
    return replaced;
  });
  for (const plan of superseded) await settlePersonalPlanSignals(plan, true);
  let window;
  try {
    window = await chrome.windows.create({
      url: chrome.runtime.getURL("plan-review.html#" + planId), type: "popup", width: 480, height: 840, focused: true,
    });
  } catch {
    await clearPersonalPlans(input.taskId, planId);
    throw coded("EXECUTION_STATE_INVALID", "Chrome could not open the plan window for the user.");
  }
  await withPersonalPlanLock(async () => {
    const plans = await readPersonalPlans();
    if (!plans[planId]) return;
    plans[planId].windowId = window.id;
    await writePersonalPlans(plans);
  });
  await Promise.resolve(chrome.notifications?.create?.("mcp-plan:" + planId, {
    type: "basic", iconUrl: PERSONAL_NOTIFICATION_ICON, title: "O MCP propõe um plano",
    message: String(input.summary).slice(0, 160) + " Sites: " + domains.join(", ").slice(0, 120),
    requireInteraction: true, priority: 2,
  })).catch(() => undefined);
  return planId;
}

// Called only from the plan window. The user may approve a subset of the sites
// and actions; a newly approved plan replaces the task's previous one.
async function decidePersonalPlan(message) {
  if (typeof message.planId !== "string" || typeof message.approve !== "boolean") throw Error("invalid");
  const decided = await withPersonalPlanLock(async () => {
    const plans = await readPersonalPlans();
    const plan = plans[message.planId];
    if (!plan || plan.status !== "pending") throw Error("not-pending");
    const feedback = typeof message.feedback === "string" ? message.feedback.trim().slice(0, 500) : "";
    if (message.approve) {
      const domains = plan.domains.filter((domain) => Array.isArray(message.domains) && message.domains.includes(domain));
      const actions = plan.actions.filter((action) => Array.isArray(message.actions) && message.actions.includes(action));
      if (domains.length === 0) throw Error("no-domains");
      for (const other of Object.values(plans)) {
        if (other.taskId === plan.taskId && other.status === "approved") other.status = "superseded";
      }
      Object.assign(plan, { status: "approved", approvedDomains: domains, approvedActions: actions });
    } else {
      plan.status = "rejected";
    }
    if (feedback) plan.feedback = feedback;
    plan.decidedAt = Date.now();
    await writePersonalPlans(plans);
    return plan;
  });
  await settlePersonalPlanSignals(decided, false);
  if (decided.status === "approved") {
    await resumePersonalTask(decided.taskId);
    await preparePersonalTaskGroup(decided).catch(() => undefined);
  }
  return { ok: true, status: decided.status };
}

async function personalPlanReviewDispatch(message) {
  if (message.type === "mcp-plan-decide") return decidePersonalPlan(message);
  if (message.type !== "mcp-plan-get") throw Error("unsupported");
  const plan = (await readPersonalPlans())[message.planId];
  if (!plan) throw Error("missing");
  return { ok: true, plan: { planId: plan.planId, taskId: plan.taskId, summary: plan.summary, steps: plan.steps,
    domains: plan.domains, actions: plan.actions, tabs: plan.tabs, status: plan.status } };
}

// Closing the window without a decision rejects the plan.
async function rejectPersonalPlanWindow(windowId) {
  const closed = await withPersonalPlanLock(async () => {
    const plans = await readPersonalPlans();
    const plan = Object.values(plans).find((candidate) => candidate.windowId === windowId && candidate.status === "pending");
    if (!plan) return undefined;
    Object.assign(plan, { status: "rejected", feedback: "The user closed the plan window without approving it.",
      decidedAt: Date.now() });
    await writePersonalPlans(plans);
    return plan;
  });
  if (closed) await settlePersonalPlanSignals(closed, false);
}

async function settlePersonalPlanSignals(plan, closeWindow) {
  await Promise.resolve(chrome.notifications?.clear?.("mcp-plan:" + plan.planId)).catch(() => undefined);
  if (closeWindow && Number.isInteger(plan.windowId)) await chrome.windows.remove(plan.windowId).catch(() => undefined);
}

// Plans end with their task; without a taskId, with every task.
async function clearPersonalPlans(taskId, onlyPlanId) {
  const removed = await withPersonalPlanLock(async () => {
    const plans = await readPersonalPlans();
    const matches = Object.values(plans).filter((plan) => onlyPlanId ? plan.planId === onlyPlanId
      : taskId === undefined || plan.taskId === taskId);
    if (matches.length === 0) return matches;
    for (const plan of matches) delete plans[plan.planId];
    await writePersonalPlans(plans);
    return matches;
  });
  for (const plan of removed) if (plan.status === "pending") await settlePersonalPlanSignals(plan, true);
}

// An approved plan also holds the task's MCP tabs to its sites in Chrome
// itself: a click, redirect or script that would load another site there is
// blocked before the page loads. Tabs the user shared stay theirs to browse;
// there, MCP's next action is refused instead. If Chrome cannot apply the
// rules, that next-action check still holds.
const PERSONAL_PLAN_RULE_BASE = 7000;
const PERSONAL_PLAN_RULE_LIMIT = 1000;
let personalPlanRulesQueue = Promise.resolve();

function syncPersonalPlanNavigationRules() {
  personalPlanRulesQueue = personalPlanRulesQueue.then(applyPersonalPlanNavigationRules).catch(() => undefined);
  return personalPlanRulesQueue;
}

async function applyPersonalPlanNavigationRules() {
  const rules = chrome.declarativeNetRequest;
  if (!rules?.updateSessionRules) return;
  const approved = Object.values(await readPersonalPlans()).filter((plan) => plan.status === "approved")
    .sort((left, right) => right.decidedAt - left.decidedAt);
  const tabsByPlan = new Map();
  for (const [key, metadata] of Object.entries(await readOwnedTabs())) {
    const chromeTabId = Number(key);
    if (metadata?.ownership !== "mcp" || !Number.isSafeInteger(chromeTabId)) continue;
    const plan = approved.find((candidate) => (typeof metadata.taskId === "string" && candidate.taskId === metadata.taskId) ||
      candidate.tabIds.includes(metadata.tabId));
    if (plan) tabsByPlan.set(plan, [...(tabsByPlan.get(plan) ?? []), chromeTabId]);
  }
  const addRules = [...tabsByPlan].slice(0, PERSONAL_PLAN_RULE_LIMIT).map(([plan, tabIds], index) => ({
    id: PERSONAL_PLAN_RULE_BASE + index, priority: 1, action: { type: "block" },
    condition: { tabIds, resourceTypes: ["main_frame"], excludedRequestDomains: plan.approvedDomains },
  }));
  const removeRuleIds = (await rules.getSessionRules()).map((rule) => rule.id)
    .filter((id) => id >= PERSONAL_PLAN_RULE_BASE && id < PERSONAL_PLAN_RULE_BASE + PERSONAL_PLAN_RULE_LIMIT);
  await rules.updateSessionRules({ removeRuleIds, addRules });
}

function personalPlanNeeds(operation, input) {
  if (operation === "dialog") return input?.action === "respond" ? ["interact"] : [];
  if (operation === "sequence" || operation === "frameSequence") {
    const steps = Array.isArray(input?.steps) ? input.steps : [];
    return [...new Set(["read", ...steps.map((step) => PERSONAL_PLAN_STEP_CATEGORIES[step?.action] ?? "interact")])];
  }
  const category = PERSONAL_PLAN_CATEGORIES[operation];
  return category ? [category] : [];
}

function personalPlanAllowsUrl(plan, url) {
  if (url === "about:blank") return true;
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    host = parsed.hostname.toLowerCase().replace(/\\.$/u, "");
  } catch {
    return false;
  }
  return plan.approvedDomains.some((domain) => host === domain || host.endsWith("." + domain));
}

// An approved plan bounds what MCP does for its task: only its sites, only its
// actions. With "Pedir um plano" on in the popup, nothing runs without one.
async function enforcePersonalPlan(operation, input) {
  const needs = personalPlanNeeds(operation, input);
  if (needs.length === 0) return;
  const approved = Object.values(await readPersonalPlans()).filter((plan) => plan.status === "approved");
  if (approved.length === 0 && !(await personalPlanRequired())) return;
  let plan;
  let chromeTabId;
  if (operation === "open") {
    plan = typeof input?.taskId === "string" ? approved.find((candidate) => candidate.taskId === input.taskId) : undefined;
  } else {
    try {
      chromeTabId = chromeTabIdFrom(input?.tabId);
    } catch {
      return;
    }
    const metadata = (await readOwnedTabs())[String(chromeTabId)];
    plan = approved
      .filter((candidate) => (typeof metadata?.taskId === "string" && candidate.taskId === metadata.taskId) ||
        candidate.tabIds.includes(input.tabId))
      .sort((left, right) => right.decidedAt - left.decidedAt)[0];
  }
  if (!plan) {
    if (!(await personalPlanRequired())) return;
    throw coded("ACTION_BLOCKED_BY_POLICY", "The user requires an approved plan before MCP acts in Chrome. " +
      "Call browser_plan with the task's taskId, steps, sites and actions first" +
      (operation === "open" ? ", then open its tabs with that taskId." : "; list a shared tab in tabIds."));
  }
  const missing = needs.filter((need) => need !== "read" && !plan.approvedActions.includes(need));
  if (missing.length > 0) {
    throw coded("ACTION_BLOCKED_BY_POLICY", "The approved plan " + plan.planId + " does not allow " +
      missing.join(", ") + ". Call browser_plan with a new plan to ask the user.");
  }
  const targets = [];
  if ((operation === "open" || operation === "navigate") && typeof input.url === "string") targets.push(input.url);
  if (operation === "sequence" && Array.isArray(input.steps)) {
    for (const step of input.steps) if (step?.action === "navigate" && typeof step.url === "string") targets.push(step.url);
  }
  if (!["open", "navigate", "goBack", "goForward"].includes(operation)) {
    const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
    if (typeof tab?.url === "string") targets.push(tab.url);
  }
  for (const url of targets) {
    if (personalPlanAllowsUrl(plan, url)) continue;
    let host = String(url).slice(0, 200);
    try {
      host = new URL(url).hostname || host;
    } catch {}
    throw coded("ACTION_BLOCKED_BY_POLICY", host + " is outside the sites approved in plan " + plan.planId + " (" +
      plan.approvedDomains.join(", ") + "). Call browser_plan with a new plan to ask the user.");
  }
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
  const { width, height, deviceScaleFactor, userAgent, colorScheme } = session.original;
  return { tabId, width, height, deviceScaleFactor, userAgent, mobile: false, touch: false,
    colorScheme, emulated: false };
}

// A real window resize must never reshape the user's own browsing window, so an
// owned tab that shares a window first moves, unfocused, into a window of its own.
// Later resizes reuse that window, and it closes with the tab.
async function resizePersonalWindow(chromeTabId, input, signal) {
  const width = input.width, height = input.height;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw coded("INVALID_ARGUMENT", "A window resize requires width and height.");
  }
  if (personalViewportSessions.has(String(chromeTabId))) {
    // Emulated metrics would hide the real window size from the page.
    await resetPersonalViewport(chromeTabId, input.tabId);
  }
  const readPage = async () => (await chrome.scripting.executeScript({
    target: { tabId: chromeTabId }, func: () => ({
      width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1,
      userAgent: navigator.userAgent, touch: (navigator.maxTouchPoints || 0) > 0,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    }),
  }))[0]?.result;
  try {
    const before = await readPage();
    const tab = await chrome.tabs.get(chromeTabId);
    const current = await chrome.windows.get(tab.windowId, { populate: true });
    let windowId = tab.windowId;
    if (current.type !== "normal" || (current.tabs || []).length !== 1) {
      // Moving the tab takes it out of its task's group; that move is MCP's, not
      // the user dragging the tab out, so the tab stays owned and is regrouped.
      pendingMcpTabs.add(chromeTabId);
      try {
        const created = await chrome.windows.create({
          tabId: chromeTabId, focused: false, state: "normal", width, height,
        });
        windowId = created.id;
        await regroupMovedPersonalTab(chromeTabId, tab.groupId, windowId);
      } finally {
        pendingMcpTabs.delete(chromeTabId);
      }
    }
    throwIfAborted(signal, "viewport", true);
    const resized = await chrome.windows.update(windowId, { state: "normal", width, height });
    // The page sees the new size asynchronously; wait for it to change and hold,
    // or to hold still when Chrome kept or clamped the size.
    let page;
    let stable = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(50, signal);
      const next = await readPage();
      stable = next && page && next.width === page.width && next.height === page.height ? stable + 1 : 0;
      page = next;
      const changed = before && page && (page.width !== before.width || page.height !== before.height);
      if ((changed && stable >= 1) || stable >= 4) break;
    }
    if (!page) throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "The resized page could not be measured.");
    return { tabId: input.tabId, width: Math.max(1, Math.round(page.width)),
      height: Math.max(1, Math.round(page.height)), deviceScaleFactor: page.dpr,
      mobile: false, touch: page.touch === true, colorScheme: page.colorScheme,
      userAgent: String(page.userAgent ?? "").slice(0, 512), emulated: false,
      window: { width: Math.max(1, resized.width ?? width), height: Math.max(1, resized.height ?? height) } };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome cannot resize the owned tab's window.");
  }
}

// A tab MCP moved into a window of its own gets a group there styled like its
// task's group, so it still shows as the task's tab and leaves the task only
// when the user drags it out of that group.
async function regroupMovedPersonalTab(chromeTabId, previousGroupId, windowId) {
  await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    const metadata = owned[String(chromeTabId)];
    if (!metadata || !Number.isInteger(metadata.mcpGroupId) || typeof metadata.taskId !== "string") return;
    let groupId;
    try {
      const style = await chrome.tabGroups.get(previousGroupId).catch(() => undefined);
      groupId = await chrome.tabs.group({ tabIds: chromeTabId, createProperties: { windowId } });
      if (style) await chrome.tabGroups.update(groupId, { title: style.title, color: style.color }).catch(() => undefined);
      await rememberMcpGroup(groupId, metadata.taskId);
    } catch {
      groupId = undefined;
    }
    owned[String(chromeTabId)] = { ...metadata, mcpGroupId: groupId };
    await writeOwnedTabs(owned);
  });
}

async function configurePersonalViewport(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "viewport", false);
  if (input.preset === "reset") return resetPersonalViewport(chromeTabId, input.tabId);
  if (input.preset === "window") return resizePersonalWindow(chromeTabId, input, signal);
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
  // Every MCP tab belongs to a task. When the caller names none, the tab gets
  // its own task, returned as tab.taskId, so finishing it closes only its tabs.
  const generatedTaskId = typeof input.taskId !== "string";
  const taskId = generatedTaskId ? "task-" + crypto.randomUUID() : input.taskId;
  if (!generatedTaskId) await resumePersonalTask(taskId);

  if (input.reusable) {
    const restored = await withOwnershipLock(async () => {
      const owned = await readOwnedTabs();
      for (const [key, metadata] of Object.entries(owned)) {
        const sameTask = generatedTaskId ? metadata.generatedTaskId === true : metadata.taskId === taskId;
        if (!sameTask || metadata.purpose !== (input.purpose ?? targetUrl)) continue;
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
  await withOwnershipLock(async () => enforcePersonalTaskTabLimit(await readOwnedTabs(), taskId));
  const tab = (await takePersonalTaskHome(taskId, targetUrl)) ?? await chrome.tabs.create({ url: targetUrl, active: true });
  if (typeof tab?.id !== "number") throw coded("INTERNAL_ERROR", "Chrome did not return a tab id.");
  pendingMcpTabs.add(tab.id);
  try {
    return await registerOpenedPersonalTab(tab, input, taskId, generatedTaskId, targetUrl, signal);
  } finally {
    pendingMcpTabs.delete(tab.id);
  }
}

async function registerOpenedPersonalTab(tab, input, taskId, generatedTaskId, targetUrl, signal) {
  // Group before the page loads so a slow page never sits outside the MCP group.
  const mcpGroupId = await withOwnershipLock(async () =>
    assignMcpTaskGroup(tab.id, taskId, await readOwnedTabs(), input.purpose ?? targetUrl));
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
      metadata = {
        tabId: PERSONAL_PREFIX + tab.id,
        taskId,
        ...(generatedTaskId ? { generatedTaskId: true } : {}),
        lifecycle: "task-scoped",
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
  await preservePersonalConsole(chromeTabId, signal);
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

function probePersonalPixelTarget(x, y, expectedUrl) {
  if (location.href !== expectedUrl) return { stale: true };
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
      x >= innerWidth || y >= innerHeight) return { outside: true };
  if (!document.elementFromPoint(x, y)) return { empty: true };
  return { x, y };
}

async function click(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "click", false);
  const pixel = input.ref === undefined && input.guard?.pixel === true &&
    input.guard.x === input.x && input.guard.y === input.y;
  if (!input.guard || (!pixel && (!input.ref || input.guard.ref !== input.ref))) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Chrome interaction requires a bound element or pixel guard.");
  }
  let point;
  if (pixel) {
    const tab = await chrome.tabs.get(chromeTabId);
    if (tab.url !== input.guard.url) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "The Chrome page changed since the confirmed screenshot.");
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: probePersonalPixelTarget,
      args: [input.x, input.y, input.guard.url],
    });
    point = injection?.result;
    if (!point || point.stale || point.outside || point.empty) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "Pixel target is stale, empty or outside the observed page.");
    }
  } else if (!input.ref.startsWith("ax-")) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: probeGuardedElement,
      args: [input.ref, input.guard, false, input.x ?? null, input.y ?? null],
    });
    point = injection?.result;
    if (!point || point.error) throw coded("BROWSER_CONFIRMATION_INVALID", "The element changed since the personal browser snapshot.");
  }
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    throwIfAborted(signal, "click", false);
    if (!pixel && input.ref.startsWith("ax-")) point = await resolveGuardedAxPoint(chromeTabId, input.ref, input.guard, target, false);
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
      args: [input.ref, input.guard, false, input.x ?? null, input.y ?? null],
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
    if (!endpoint || !guard) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "Drag requires a bound source and destination.");
    }
    if (!endpoint.ref) {
      if (!guard.pixel || endpoint.x !== guard.x || endpoint.y !== guard.y) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "Physical drag endpoint is not bound to its confirmation.");
      }
      const tab = await chrome.tabs.get(chromeTabId);
      if (tab.url !== guard.url) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "The page changed since the pixel drag screenshot.");
      }
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: probePersonalPixelTarget,
        args: [endpoint.x, endpoint.y, guard.url],
      });
      if (!Number.isInteger(probe?.result?.x) || !Number.isInteger(probe?.result?.y)) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "Physical drag endpoint is stale, empty or outside the viewport.");
      }
      return probe.result;
    }
    if (guard.ref !== endpoint.ref) {
      throw coded("BROWSER_CONFIRMATION_INVALID", "Drag reference changed since the snapshot.");
    }
    if (endpoint.ref.startsWith("ax-")) return undefined;
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: probeGuardedElement,
      args: [endpoint.ref, guard, false, endpoint.x ?? null, endpoint.y ?? null],
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
  let intercepting = false;
  let dragData;
  // A native HTML5 drag would enter the OS drag loop, which ignores further
  // CDP mouse input in a real window; intercept it and deliver drag events.
  const onDragIntercepted = (source, method, params) => {
    if (source?.tabId === chromeTabId && method === "Input.dragIntercepted") dragData = params?.data;
  };
  try {
    attached = await attachGuardedDebugger(target);
    if (input.from.ref?.startsWith("ax-")) from = await resolveGuardedAxPoint(
      chromeTabId, input.from.ref, input.fromGuard, target, false,
    );
    if (input.to.ref?.startsWith("ax-")) to = await resolveGuardedAxPoint(
      chromeTabId, input.to.ref, input.toGuard, target, false,
    );
    // A fresh attach shows Chrome's debugging infobar, which resizes the page
    // and cancels a press already in progress; start once the viewport settles
    // and measure the endpoints again in case the layout moved.
    if (attached || takeFreshPersonalDebugger(target)) {
      await settlePersonalViewport(target, signal);
      if (!input.from.ref?.startsWith("ax-")) from = await resolve(input.from, input.fromGuard);
      if (!input.to.ref?.startsWith("ax-")) to = await resolve(input.to, input.toGuard);
    }
    chrome.debugger.onEvent?.addListener?.(onDragIntercepted);
    await chrome.debugger.sendCommand(target, "Input.setInterceptDrags", { enabled: true });
    intercepting = true;
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
      if (dragData) break;
    }
    for (let wait = 0; !dragData && wait < 6; wait += 1) await delay(50, signal);
    if (dragData) {
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await chrome.debugger.sendCommand(target, "Input.dispatchDragEvent", {
          type, x: to.x, y: to.y, data: dragData,
        });
      }
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
    chrome.debugger.onEvent?.removeListener?.(onDragIntercepted);
    if (intercepting) {
      await chrome.debugger.sendCommand(target, "Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
    }
    if (attached || globalThis.__mcpV3PersonalNetworkCaptures?.has(String(target.tabId)) ||
        globalThis.__mcpV3PersonalTaskDebuggers?.has(String(target.tabId))) {
      if (pressed) await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: to?.x ?? from?.x ?? 0, y: to?.y ?? from?.y ?? 0,
        button: "left", buttons: 0,
      }).catch(() => undefined);
      await detachGuardedDebugger(target, attached).catch(() => undefined);
    }
  }
}

// Waits (at most 800 ms) until the layout viewport keeps one size for three
// consecutive reads 50 ms apart.
async function settlePersonalViewport(target, signal) {
  const read = async () => {
    const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics").catch(() => undefined);
    const viewport = metrics?.cssLayoutViewport;
    return viewport ? viewport.clientWidth + "x" + viewport.clientHeight : "";
  };
  let previous = await read();
  let stable = 0;
  for (let attempt = 0; attempt < 16 && stable < 3; attempt += 1) {
    await delay(50, signal);
    const current = await read();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
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

// CDP physical keyboard events are needed by autocomplete, masks and rich editors.
// US-ASCII characters map to their US key. Other characters still arrive as one
// trusted keystroke carrying their own key value, as on a native layout: accented
// Latin letters keep their base letter's physical code, other scripts report no
// physical key. Control characters other than newline have no keystroke.
function physicalTypingKey(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint >= 65 && codePoint <= 90) return {
    key: character, code: "Key" + character, keyCode: codePoint, modifiers: 8,
  };
  if (codePoint >= 97 && codePoint <= 122) return {
    key: character, code: "Key" + character.toUpperCase(), keyCode: codePoint - 32, modifiers: 0,
  };
  if (codePoint >= 48 && codePoint <= 57) return {
    key: character, code: "Digit" + character, keyCode: codePoint, modifiers: 0,
  };
  if (character === " ") return { key: " ", code: "Space", keyCode: 32, modifiers: 0 };
  if (codePoint === 10) return { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 };
  const symbols = {
    "-": ["Minus", 189, 0], "_": ["Minus", 189, 8],
    "=": ["Equal", 187, 0], "+": ["Equal", 187, 8],
    ".": ["Period", 190, 0], ">": ["Period", 190, 8],
    ",": ["Comma", 188, 0], "<": ["Comma", 188, 8],
    "/": ["Slash", 191, 0], "?": ["Slash", 191, 8],
    ";": ["Semicolon", 186, 0], ":": ["Semicolon", 186, 8],
    "'": ["Quote", 222, 0], '"': ["Quote", 222, 8],
    "[": ["BracketLeft", 219, 0], "{": ["BracketLeft", 219, 8],
    "]": ["BracketRight", 221, 0], "}": ["BracketRight", 221, 8],
    "|": ["Backslash", 220, 8],
    "!": ["Digit1", 49, 8], "@": ["Digit2", 50, 8],
    "#": ["Digit3", 51, 8], "$": ["Digit4", 52, 8],
    "%": ["Digit5", 53, 8], "^": ["Digit6", 54, 8],
    "&": ["Digit7", 55, 8], "*": ["Digit8", 56, 8],
    "(": ["Digit9", 57, 8], ")": ["Digit0", 48, 8],
  };
  const mapping = symbols[character];
  if (mapping) return { key: character, code: mapping[0], keyCode: mapping[1], modifiers: mapping[2] };
  if (codePoint < 32 || (codePoint >= 127 && codePoint < 160)) return null;
  const base = character.normalize("NFD").charAt(0);
  const latin = base !== character && /^[A-Za-z]$/u.test(base) ? physicalTypingKey(base) : null;
  return latin ? { key: character, code: latin.code, keyCode: latin.keyCode, modifiers: latin.modifiers } :
    { key: character, code: "", keyCode: 0, modifiers: 0 };
}

// Han, kana and Hangul are typed through an input method on every desktop OS, so
// slow typing commits them as one IME composition per run, as editors expect.
function imeComposedCharacter(character) {
  return /[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Bopomofo}]/u.test(character);
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
  let composing;
  try {
    attached = await attachGuardedDebugger(target);
    if (input.slowly) {
      const processKey = { key: "Process", code: "", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 };
      const chars = Array.from(input.text);
      for (let index = 0; index < chars.length; index += 1) {
        throwIfAborted(signal, "type", true);
        const char = chars[index];
        if (imeComposedCharacter(char)) {
          composing = "";
          while (index < chars.length && imeComposedCharacter(chars[index])) {
            throwIfAborted(signal, "type", true);
            composing += chars[index];
            await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...processKey, type: "rawKeyDown" });
            await chrome.debugger.sendCommand(target, "Input.imeSetComposition", {
              text: composing, selectionStart: composing.length, selectionEnd: composing.length,
            });
            await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...processKey, type: "keyUp" });
            await new Promise((resolve) => setTimeout(resolve, 15));
            index += 1;
          }
          index -= 1;
          const committed = composing;
          composing = undefined;
          await chrome.debugger.sendCommand(target, "Input.insertText", { text: committed });
          continue;
        }
        const physical = physicalTypingKey(char);
        if (physical) {
          const args = { key: physical.key, code: physical.code,
            windowsVirtualKeyCode: physical.keyCode, nativeVirtualKeyCode: physical.keyCode,
            modifiers: physical.modifiers };
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            ...args, type: "keyDown", text: char, unmodifiedText: char,
          });
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            ...args, type: "keyUp",
          });
        } else {
          await chrome.debugger.sendCommand(target, "Input.insertText", { text: char });
        }
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
    if (composing !== undefined) {
      // Never leave a half-typed composition behind in the user's page.
      await chrome.debugger.sendCommand(target, "Input.imeSetComposition", {
        text: "", selectionStart: 0, selectionEnd: 0,
      }).catch(() => undefined);
    }
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
  if (typeof input.forUser === "string") return waitForUser(input, signal);
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

async function extract(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "extract", false);
  if (input.completion === "document-and-safe-pagination") {
    return extractWithSafePagination(input, chromeTabId, signal);
  }
  const tab = await chrome.tabs.get(chromeTabId);
  assertPersonalNavigationTarget(tab.url);
  const result = await readPersonalExtraction(chromeTabId, input, tab.url, input.completion === "document");
  throwIfAborted(signal, "extract", false);
  return {
    tabId: input.tabId,
    format: input.format ?? "text",
    value: result.value,
    ...(result.completeness ? { completeness: result.completeness } : {}),
  };
}

async function readPersonalExtraction(chromeTabId, input, expectedUrl, complete) {
  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: complete ? extractCompletePersonalFrame : extractPage,
      args: [input.ref ?? null, input.selector ?? null, input.format ?? "text", expectedUrl],
    });
  } catch {
    throw coded("FRAME_NOT_READY", "Owned Chrome document is unavailable for extraction.");
  }
  if (!result || result.result?.stale) {
    throw coded("FRAME_NOT_READY", "The owned Chrome document navigated during extraction.");
  }
  if (!result.result?.found) {
    throw coded("LOCATOR_NOT_FOUND", "The requested personal browser extraction target was not found.");
  }
  return result.result;
}

const PERSONAL_PAGINATION_MAX_PAGES = 5;
const PERSONAL_PAGINATION_MAX_BYTES = 480000;
const PERSONAL_PAGINATION_BUDGET_MS = 50000;

// Follows only semantic rel=next links inside this owned tab, never arbitrary
// "Next" controls: same origin, public http(s), bounded pages, bytes and time,
// and it stops on cycles, redirects away from the origin or missing targets.
async function extractWithSafePagination(input, chromeTabId, signal) {
  const format = input.format ?? "text";
  const deadline = Date.now() + PERSONAL_PAGINATION_BUDGET_MS;
  const values = [];
  const visited = new Set();
  const signatures = new Set();
  let origin;
  let scrolls = 0;
  const finish = (status, reason, paginationAvailable) => {
    const combined = values.length > 1 ? values.join(String.fromCharCode(10, 10)) : values[0] ?? "";
    const value = typeof combined === "string"
      ? boundPersonalText(combined, PERSONAL_PAGINATION_MAX_BYTES) : combined;
    const truncated = value !== combined;
    const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
    return {
      tabId: input.tabId, format, value,
      completeness: {
        status: truncated ? "partial" : status, reason: truncated ? "byte-limit" : reason,
        mode: "document-and-safe-pagination", pages: Math.max(1, values.length), scrolls, bytes,
        ...(paginationAvailable ? { paginationAvailable: true } : {}),
      },
    };
  };
  while (true) {
    throwIfAborted(signal, "extract", false);
    const metadata = await requireOwnedMetadata(chromeTabId);
    const tab = await chrome.tabs.get(chromeTabId);
    let pageUrl;
    try {
      pageUrl = new URL(assertPersonalNavigationTarget(tab.url));
    } catch (error) {
      if (values.length === 0) throw error;
      return finish("partial", "unsafe-pagination", false);
    }
    // A redirect away from the first page's origin ends pagination unread.
    origin ??= pageUrl.origin;
    if (pageUrl.origin !== origin) return finish("partial", "unsafe-pagination", false);
    let page;
    try {
      page = await readPersonalExtraction(chromeTabId, input, tab.url, true);
    } catch (error) {
      if (values.length === 0 || !error?.code) throw error;
      return finish("partial", "no-progress", false);
    }
    const text = typeof page.value === "string" ? page.value : JSON.stringify(page.value);
    const signature = personalTextSignature(text);
    if (signatures.has(signature)) return finish("partial", "cycle", true);
    signatures.add(signature);
    visited.add(withoutPersonalHash(pageUrl));
    values.push(page.value);
    scrolls += Number.isInteger(page.completeness?.scrolls) ? page.completeness.scrolls : 0;
    const nextUrl = await probePersonalNextPage(chromeTabId, tab.url);
    if (page.completeness?.status !== "complete") {
      return finish("partial", page.completeness?.reason ?? "no-progress", Boolean(nextUrl));
    }
    if (!nextUrl) return finish("complete", "pagination-end", false);
    if (format !== "text" || typeof input.ref === "string" || metadata.sticky) {
      return finish("partial", "unsafe-pagination", true);
    }
    if (values.length >= PERSONAL_PAGINATION_MAX_PAGES) return finish("partial", "page-limit", true);
    let target;
    try {
      target = new URL(assertPersonalNavigationTarget(nextUrl));
    } catch {
      return finish("partial", "unsafe-pagination", true);
    }
    if (target.origin !== pageUrl.origin) return finish("partial", "unsafe-pagination", true);
    if (visited.has(withoutPersonalHash(target))) return finish("partial", "cycle", true);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return finish("partial", "time-limit", true);
    axTargetsByTab.delete(chromeTabId);
    await preservePersonalConsole(chromeTabId, signal);
    const loaded = await loadPersonalTabUrl(chromeTabId, target.href, Math.min(30000, remaining), signal);
    metadata.lastUsedAt = new Date().toISOString();
    metadata.requestedUrl = target.href;
    await updateMetadata(chromeTabId, metadata);
    if (!loaded) return finish("partial", "time-limit", true);
  }
}

function withoutPersonalHash(url) {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function personalTextSignature(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16) + ":" + text.length;
}

function boundPersonalText(value, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && encoder.encode(value.slice(0, end)).byteLength > maxBytes) end = Math.floor(end * 0.9);
  return value.slice(0, end);
}

async function probePersonalNextPage(chromeTabId, expectedUrl) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: readPersonalNextPageLink,
    args: [expectedUrl],
  }).catch(() => []);
  return typeof result?.result === "string" ? result.result : null;
}

// Runs in the page: only a semantic rel=next link or anchor counts as pagination.
function readPersonalNextPageLink(expectedUrl) {
  if (location.href !== expectedUrl) return null;
  const link = document.querySelector('link[rel~="next"][href],a[rel~="next"][href]');
  const href = link?.getAttribute("href");
  if (!href) return null;
  try { return new URL(href, location.href).href; } catch { return null; }
}

// Waits for the owned tab to start and finish loading the requested URL; a
// timeout resolves false so already collected pages are still returned.
async function loadPersonalTabUrl(chromeTabId, url, timeoutMs, signal) {
  let cleanup = () => undefined;
  const loaded = new Promise((resolve, reject) => {
    let loading = false;
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const onAbort = () => { cleanup(); reject(cancellationError("extract", signal, false)); };
    const onUpdated = (tabId, change) => {
      if (tabId !== chromeTabId) return;
      if (change.status === "loading") loading = true;
      else if (change.status === "complete" && loading) { cleanup(); resolve(true); }
    };
    cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  try {
    await chrome.tabs.update(chromeTabId, { url });
  } catch {
    cleanup();
    throw coded("FRAME_NOT_READY", "Chrome refused to load the next page in the owned tab.");
  }
  return loaded;
}

// Discover only scriptable child frames of this explicitly MCP-owned Chrome tab.
// Names and document titles must match exactly; ambiguous targets fail closed.
// The injected code executes independently inside each accessible frame, including
// cross-origin frames for which Chrome granted host permission.
function describePersonalFrame() {
  return {
    url: location.href, name: window.name || "", title: document.title || "",
    // A cross-origin child cannot access its frameElement. Its parent's public
    // iframe attributes can still resolve a unique named frame by exact src.
    embedded: Array.from(document.querySelectorAll("iframe,frame")).slice(0, 128).map((frame) => ({
      id: frame.id || "", name: frame.getAttribute("name") || "",
      title: frame.getAttribute("title") || "", src: frame.src || "",
    })),
  };
}

// Runs inside the selected frame, not in the service worker. Capture is bounded,
// restores scroll position and never follows links or interacts with another tab.
async function extractCompletePersonalFrame(ref, selector, format, expectedUrl) {
  if (location.href !== expectedUrl) return { found: false, stale: true };
  const element = typeof ref === "string"
    ? globalThis.__mcpV3OwnedRefElements?.get(ref)
    : selector ? document.querySelector(selector) : document.body;
  if (!element || typeof ref === "string" && !element.isConnected) return { found: false };
  const scrollNode = selector || ref ? element : (document.scrollingElement || document.documentElement);
  const originalScroll = scrollNode.scrollTop;
  const deadline = Date.now() + 3500;
  const maxScrolls = 12;
  const maxBytes = 160000;
  let scrolls = 0;
  let reason = "scroll-limit";
  let output = "";
  let previous = "";
  let unchanged = 0;
  let stableEnd = 0;
  try {
    while (true) {
      if (location.href !== expectedUrl) return { found: false, stale: true };
      const current = String(format === "html"
        ? (element.outerHTML || element.innerHTML || "")
        : (element.innerText || element.textContent || ""));
      // Preserve growing page text, while retaining distinct virtualized chunks.
      if (current.length > output.length && current.includes(output)) output = current;
      else if (current !== previous && !output.includes(current)) {
        output += (output ? String.fromCharCode(10) : "") + current;
      }
      previous = current;
      const bytes = new TextEncoder().encode(output).byteLength;
      if (bytes > maxBytes) { reason = "byte-limit"; break; }
      const bottom = scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 2;
      stableEnd = bottom ? stableEnd + 1 : 0;
      unchanged = current === output ? unchanged + 1 : 0;
      if (stableEnd >= 2) { reason = "end-of-document"; break; }
      if (Date.now() >= deadline) { reason = "time-limit"; break; }
      if (scrolls >= maxScrolls) { reason = "scroll-limit"; break; }
      if (unchanged > 6 && !bottom) { reason = "no-progress"; break; }
      scrollNode.scrollTop = Math.min(scrollNode.scrollHeight, scrollNode.scrollTop + Math.max(1, scrollNode.clientHeight * 0.8));
      scrolls += 1;
      await new Promise((resolve) => setTimeout(resolve, 85));
    }
  } finally {
    scrollNode.scrollTop = originalScroll;
  }
  const bounded = new TextEncoder().encode(output).byteLength > maxBytes
    ? output.slice(0, Math.floor(maxBytes / 4)) : output;
  const bytes = new TextEncoder().encode(bounded).byteLength;
  const value = format === "json"
    ? { text: bounded, tag: element.tagName?.toLowerCase?.() || null }
    : bounded;
  return { found: true, value, completeness: {
    status: reason === "end-of-document" ? "complete" : "partial",
    reason, mode: "document", pages: 1, scrolls, bytes,
  } };
}

async function frameExtract(input, signal) {
  if (input.completion === "document-and-safe-pagination") {
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED",
      "Cross-page pagination is not safe without an explicit, verified navigation plan.");
  }
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "frameExtract", false);
  if (typeof input.frame !== "string" || input.frame.length === 0 || input.frame.length > 200) {
    throw coded("INVALID_ARGUMENT", "Frame name is required.");
  }
  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId, allFrames: true },
      func: describePersonalFrame,
    });
  } catch {
    throw coded("FRAME_NOT_READY", "Chrome cannot inspect the requested frame with its current permissions.");
  }
  const aliases = new Set((frames || []).flatMap((parent) =>
    (parent.result?.embedded || [])
      .filter((frame) => [frame.id, frame.name, frame.title].includes(input.frame))
      .map((frame) => frame.src)
      .filter((src) => src.startsWith("https://") || src.startsWith("http://"))));
  const matches = (frames || []).filter((entry) =>
    entry.frameId !== 0 && entry.result &&
    ([entry.result.name, entry.result.title, entry.result.url].includes(input.frame) ||
      aliases.has(entry.result.url)));
  if (matches.length === 0) throw coded("FRAME_NOT_FOUND", "No accessible child frame matches the exact frame name.");
  if (matches.length !== 1) throw coded("LOCATOR_AMBIGUOUS", "Multiple child frames match the requested name.");
  const matched = matches[0];
  assertPersonalNavigationTarget(matched.result.url);
  throwIfAborted(signal, "frameExtract", false);
  let extracted;
  try {
    [extracted] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId, frameIds: [matched.frameId] },
      func: input.completion === "document" ? extractCompletePersonalFrame : extractPage,
      args: [null, input.selector ?? null, input.format ?? "text", matched.result.url],
    });
  } catch {
    throw coded("FRAME_NOT_READY", "The child frame is no longer accessible.");
  }
  if (!extracted || extracted.frameId !== matched.frameId ||
      (matched.documentId && extracted.documentId !== matched.documentId) ||
      extracted.result?.stale) {
    throw coded("FRAME_NOT_READY", "The child frame navigated during extraction.");
  }
  if (!extracted.result?.found) throw coded("LOCATOR_NOT_FOUND", "The requested frame extraction target does not exist.");
  throwIfAborted(signal, "frameExtract", false);
  return { tabId: input.tabId, frame: input.frame, format: input.format ?? "text", value: extracted.result.value,
    ...(extracted.result.completeness ? { completeness: extracted.result.completeness } : {}),
  };
}

// Match only a scriptable, uniquely identified direct child frame. The CDP
// pointer stays in top-level CSS coordinates; deeper/navigated/redirected frame
// geometry is intentionally rejected instead of producing a misdirected click.
function probeDirectFrameElement(expectedParentUrl, expectedChildUrl, localPoint) {
  if (location.href !== expectedParentUrl) return { stale: true };
  const frames = Array.from(document.querySelectorAll("iframe,frame")).filter(
    (element) => element.src === expectedChildUrl);
  if (frames.length !== 1) return { ambiguous: frames.length > 1, missing: frames.length === 0 };
  const element = frames[0];
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (style.transform !== "none" ||
      Math.abs(rect.width - element.offsetWidth) > 2 ||
      Math.abs(rect.height - element.offsetHeight) > 2 ||
      rect.width <= 0 || rect.height <= 0) return { unsupported: true };
  const x = rect.left + element.clientLeft + localPoint.x;
  const y = rect.top + element.clientTop + localPoint.y;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ||
      document.elementFromPoint(x, y) !== element) return { obscured: true };
  return { x, y };
}

function probeDirectFrameControl(expectedUrl, selector, text, match, index, filling) {
  if (location.href !== expectedUrl) return { stale: true };
  const candidates = selector
    ? Array.from(document.querySelectorAll(selector)).slice(0, 201)
    : Array.from(document.querySelectorAll("button,a,summary,input[type=submit],[role=button]")).slice(0, 201);
  if (candidates.length > 200) return { ambiguous: true };
  const matched = candidates.filter((node) => {
    if (text == null) return true;
    const label = (node.innerText || node.textContent || node.value || "").trim();
    return match === "contains" ? label.includes(text) : label === text;
  });
  if (matched.length === 0) return { missing: true };
  if (index == null && matched.length !== 1) return { ambiguous: true };
  if (index != null && (index < 0 || index >= matched.length)) return { missing: true };
  const element = matched[index ?? 0];
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "").toLowerCase();
  if (element.disabled || element.getAttribute("aria-disabled") === "true") return { disabled: true };
  if (filling && !(tag === "textarea" || (tag === "input" &&
       !["file", "hidden", "submit", "button", "radio", "checkbox", "reset"].includes(type)) ||
       element.isContentEditable)) return { notEditable: true };
  if (filling && element.readOnly) return { notEditable: true };
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 ||
      x >= innerWidth || y >= innerHeight) return { invisible: true };
  const hit = document.elementFromPoint(x, y);
  if (hit !== element && !element.contains(hit)) return { obscured: true };
  return { x, y, tag };
}

function confirmDirectFrameFocus(expectedUrl, selector) {
  if (location.href !== expectedUrl) return false;
  const element = document.querySelector(selector);
  return Boolean(element && (document.activeElement === element ||
    (element.isContentEditable && element.contains(document.activeElement))));
}

async function directFrameAction(input, signal, filling) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  const tab = await chrome.tabs.get(chromeTabId);
  if (!input.guard || !input.guard.url || tab.url !== input.guard.url) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Frame action requires an observed parent tab URL.");
  }
  throwIfAborted(signal, "frameAction", false);
  let discovery;
  try {
    discovery = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId, allFrames: true }, func: describePersonalFrame,
    });
  } catch {
    throw coded("FRAME_NOT_READY", "Frame discovery is unavailable.");
  }
  const aliases = new Set((discovery || []).flatMap((parent) =>
    (parent.result?.embedded || [])
      .filter((element) => [element.id, element.name, element.title].includes(input.frame))
      .map((element) => element.src)));
  const matches = (discovery || []).filter((entry) => entry.frameId !== 0 && entry.result &&
    ([entry.result.url, entry.result.name, entry.result.title].includes(input.frame) ||
      aliases.has(entry.result.url)));
  if (matches.length !== 1) {
    throw coded(matches.length ? "LOCATOR_AMBIGUOUS" : "FRAME_NOT_FOUND",
      "Frame mutation requires one exact scriptable target.");
  }
  const frame = matches[0];
  assertPersonalNavigationTarget(frame.result.url);
  let candidate;
  try {
    [candidate] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId, frameIds: [frame.frameId] },
      func: probeDirectFrameControl,
      args: [frame.result.url, input.selector ?? null, input.text ?? null,
        input.match ?? "exact", input.index ?? null, filling],
    });
  } catch {
    throw coded("FRAME_NOT_READY", "The frame control cannot be inspected.");
  }
  if (!candidate || candidate.frameId !== frame.frameId ||
      (frame.documentId && candidate.documentId !== frame.documentId) ||
      candidate.result?.stale) throw coded("FRAME_NOT_READY", "Frame changed while resolving the control.");
  const point = candidate.result;
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw coded(point?.ambiguous ? "LOCATOR_AMBIGUOUS" : "LOCATOR_NOT_FOUND",
      "Frame target is missing, obscured, disabled or not editable.");
  }
  let parent;
  try {
    [parent] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId }, func: probeDirectFrameElement,
      args: [input.guard.url, frame.result.url, point],
    });
  } catch {
    throw coded("FRAME_NOT_READY", "Direct-frame geometry cannot be verified.");
  }
  if (!Number.isFinite(parent?.result?.x) || !Number.isFinite(parent?.result?.y)) {
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED",
      "Frame target needs a visible, unique untransformed direct iframe; nested or redirected frames are unsupported.");
  }
  const before = await chrome.tabs.get(chromeTabId);
  if (before.url !== input.guard.url) throw coded("BROWSER_CONFIRMATION_INVALID", "The parent navigated.");
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    attached = await attachGuardedDebugger(target);
    throwIfAborted(signal, "frameAction", false);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type, x: parent.result.x, y: parent.result.y,
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
      });
    }
    if (filling) {
      const current = await chrome.tabs.get(chromeTabId);
      if (current.url !== input.guard.url) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "The frame host navigated before input.");
      }
      const [focused] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId, frameIds: [frame.frameId] },
        func: confirmDirectFrameFocus, args: [frame.result.url, input.selector ?? null],
      });
      if (!focused || focused.frameId !== frame.frameId ||
          (frame.documentId && focused.documentId !== frame.documentId) ||
          !focused.result) throw coded("FRAME_NOT_READY", "The intended field did not receive native focus.");
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
      });
      await chrome.debugger.sendCommand(target, "Input.insertText", { text: input.value });
    }
    return { tabId: input.tabId, completed: true };
  } catch (error) {
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Native frame input is unavailable or the debugger is occupied.");
  } finally {
    await detachGuardedDebugger(target, attached).catch(() => undefined);
  }
}

async function frameClick(input, signal) {
  return directFrameAction(input, signal, false);
}

async function frameFill(input, signal) {
  return directFrameAction(input, signal, true);
}

// Read-only legacy profiling. Frame ancestry comes from Chrome's own frame IDs,
// not from guessed iframe names or DOM access across origins.
function inspectPersonalLegacyDocument() {
  const count = (selector) => document.querySelectorAll(selector).length;
  const embedded = Array.from(document.querySelectorAll("iframe,frame")).slice(0, 100).map((node) => ({
    id: (node.id || "").slice(0, 200),
    name: (node.getAttribute("name") || "").slice(0, 200),
    src: (node.src || "").slice(0, 2048),
  }));
  return {
    url: location.href, name: (window.name || "").slice(0, 200),
    title: (document.title || "").slice(0, 500),
    readyState: document.readyState,
    childElementCount: document.documentElement?.childElementCount ?? 0,
    embedded,
    signals: {
      layoutTables: count("table:not([role='grid'])"),
      inlineHandlers: count("[onclick],[onchange],[onkeyup],[ondblclick],[onmousedown]"),
      hashLinks: count("a[href^='#']"),
      targetedNavigation: count("[target]:not([target='_self'])"),
      postForms: count("form[method='post' i]"),
    },
  };
}

// Fingerprints are non-security cache signatures, never authentication proofs.
function personalLegacySignature(input) {
  let hash = 2166136261;
  const value = typeof input === "string" ? input : JSON.stringify(input);
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function inspectPersonalFrameGraph(chromeTabId) {
  if (!chrome.webNavigation?.getAllFrames) {
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome webNavigation permission is required for exact frame ancestry.");
  }
  const tab = await chrome.tabs.get(chromeTabId);
  assertPersonalNavigationTarget(tab.url);
  const [navigation, observations] = await Promise.all([
    chrome.webNavigation.getAllFrames({ tabId: chromeTabId }),
    chrome.scripting.executeScript({
      target: { tabId: chromeTabId, allFrames: true },
      func: inspectPersonalLegacyDocument,
    }),
  ]);
  if (!Array.isArray(navigation) || navigation.length === 0 ||
      navigation.length > 101 || !navigation.some((entry) => entry.frameId === 0)) {
    throw coded("FRAME_NOT_READY", "Chrome returned an incomplete or oversized frame graph.");
  }
  const byId = new Map();
  for (const entry of navigation) {
    if (!Number.isInteger(entry.frameId) || !Number.isInteger(entry.parentFrameId) ||
        byId.has(entry.frameId)) throw coded("FRAME_NOT_READY", "Frame IDs are inconsistent.");
    byId.set(entry.frameId, {
      frameId: entry.frameId, parentFrameId: entry.parentFrameId,
      url: entry.url, children: [], status: "inaccessible",
    });
  }
  const observed = new Map();
  for (const item of observations || []) {
    if (observed.has(item.frameId)) throw coded("FRAME_NOT_READY", "Duplicate scriptable frame ID.");
    observed.set(item.frameId, item);
  }
  for (const frame of byId.values()) {
    if (frame.frameId !== 0) {
      const parent = byId.get(frame.parentFrameId);
      if (!parent) throw coded("FRAME_NOT_READY", "Frame ancestry is incomplete.");
      parent.children.push(frame);
    }
    try {
      assertPersonalNavigationTarget(frame.url);
      const injection = observed.get(frame.frameId);
      if (injection?.result?.url === frame.url) {
        frame.data = injection.result;
        frame.documentId = injection.documentId;
        frame.status = frame.data.readyState === "loading" ? "not-ready" : "ready";
      } else {
        frame.status = "inaccessible";
      }
    } catch {
      frame.status = "inaccessible";
    }
  }
  const root = byId.get(0);
  if (root.url !== tab.url || !root.data) {
    throw coded("FRAME_NOT_READY", "The owned parent tab changed during frame inspection.");
  }
  // Resolve a safe child label from the child's window.name or a unique parent
  // element URL; unnamed siblings use their structural index.
  const visited = new Set([0]);
  const visit = (parent, path, depth) => {
    parent.children.sort((a, b) => a.frameId - b.frameId);
    for (const [index, child] of parent.children.entries()) {
      if (visited.has(child.frameId) || depth > 100) {
        throw coded("FRAME_NOT_READY", "Chrome frame graph has a cycle or excessive depth.");
      }
      visited.add(child.frameId);
      const aliases = (parent.data?.embedded || []).filter((node) => node.src === child.url);
      const alias = aliases.length === 1 ? aliases[0] : null;
      child.index = index;
      child.name = child.data?.name || alias?.name || "";
      child.id = alias?.id || "";
      let segment = child.name || child.id || String(index);
      const duplicates = parent.children.filter((candidate) => {
        const matches = (parent.data?.embedded || []).filter((node) => node.src === candidate.url);
        const match = matches.length === 1 ? matches[0] : null;
        return (candidate.data?.name || match?.name || match?.id || String(parent.children.indexOf(candidate))) === segment;
      });
      if (duplicates.length > 1) segment = String(index);
      child.path = [...path, segment];
      child.depth = depth;
      visit(child, child.path, depth + 1);
    }
  };
  root.path = [];
  root.depth = 0;
  visit(root, [], 1);
  if (visited.size !== byId.size) {
    throw coded("FRAME_NOT_READY", "Chrome returned an orphaned or cyclic frame graph.");
  }
  const end = await chrome.tabs.get(chromeTabId);
  if (end.url !== tab.url) throw coded("FRAME_NOT_READY", "The tab navigated during frame inspection.");
  return { root, byId };
}

async function profilePage(input, signal, precomputedGraph) {
  const started = performance.now();
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "profilePage", false);
  const graph = precomputedGraph || await inspectPersonalFrameGraph(chromeTabId);
  const maxDepth = input.maxDepth ?? 8;
  const signals = {
    frames: graph.byId.size - 1, nestedFrames: 0,
    layoutTables: 0, inlineHandlers: 0, hashLinks: 0,
    targetedNavigation: 0, postForms: 0,
  };
  for (const frame of graph.byId.values()) {
    if (frame.frameId !== 0 && frame.depth > 1) signals.nestedFrames += 1;
    for (const key of ["layoutTables", "inlineHandlers", "hashLinks",
      "targetedNavigation", "postForms"]) {
      signals[key] += frame.data?.signals?.[key] || 0;
    }
  }
  const categories = [];
  if (signals.frames) categories.push("legacy-frames");
  if (signals.layoutTables) categories.push("legacy-table-layout");
  if (signals.postForms) categories.push("legacy-form-post");
  if (signals.inlineHandlers || signals.hashLinks || signals.targetedNavigation) categories.push("legacy-script-navigation");
  const profile = categories.length === 0 ? "modern" :
    categories.length === 1 ? categories[0] : "hybrid";
  const makeNode = (frame) => ({
    path: frame.path, index: frame.index, status: frame.status,
    ...(frame.name ? { name: frame.name } : {}),
    ...(frame.id ? { id: frame.id } : {}),
    ...(frame.data?.readyState ? { readyState: frame.data.readyState.slice(0, 50) } : {}),
    signature: personalLegacySignature([frame.frameId, frame.url, frame.status, frame.data?.childElementCount || 0]),
    children: frame.depth < maxDepth ? frame.children.map(makeNode) : [],
  });
  const frames = maxDepth ? graph.root.children.map(makeNode) : [];
  const frameGraphSignature = personalLegacySignature([...graph.byId.values()].map((f) =>
    [f.frameId, f.parentFrameId, f.url, f.status]));
  const pageSignature = personalLegacySignature([
    graph.root.url, graph.root.data.title, graph.root.data.childElementCount, signals, frameGraphSignature,
  ]);
  throwIfAborted(signal, "profilePage", false);
  return { tabId: input.tabId, profile, signals,
    pageSignature, frameGraphSignature, frames,
    telemetry: { totalMs: Math.max(0, performance.now() - started),
      frameResolutionMs: Math.max(0, performance.now() - started), retries: 0 },
  };
}

// Index only actionable elements, not form field values or arbitrary private
// text. Selectors are unique within the actual selected frame document.
function collectPersonalLegacyIndex(expectedUrl, options) {
  if (location.href !== expectedUrl) return { stale: true };
  let root = document;
  try {
    if (options.rootSelector) root = document.querySelector(options.rootSelector);
  } catch {
    return { invalidSelector: true };
  }
  if (!root) return { missing: true };
  const selector = [
    "button", "a[href]", "input:not([type='hidden'])", "textarea", "select", "summary",
    "[role='button']", "[role='link']", "[role='checkbox']", "[role='radio']",
    "[role='combobox']", "[role='option']", "[role='menuitem']", "[role='tab']",
    "[role='switch']", "[role='slider']", "[contenteditable='true']",
  ].join(",");
  const candidates = Array.from(root.querySelectorAll(selector));
  const capped = candidates.length > 5000;
  const results = [];
  for (const element of candidates.slice(0, 5000)) {
    const tag = element.tagName.toLowerCase();
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const visible = style.display !== "none" && style.visibility !== "hidden" &&
      rect.width > 0 && rect.height > 0;
    if (options.visibleOnly && !visible) continue;
    const attr = (name, cap = 256) => (element.getAttribute(name) || "").slice(0, cap);
    const type = attr("type", 100).toLowerCase();
    const role = attr("role", 100);
    // Never inspect .value, even for non-password controls. It can contain PII.
    const label = attr("aria-label", 500) || attr("title", 500) ||
      (tag === "input" || tag === "textarea" || tag === "select"
        ? attr("placeholder", 500)
        : (element.innerText || element.textContent || "").trim().slice(0, 500));
    const id = attr("id");
    const name = attr("name");
    const searchable = [label, id, name, role, type, tag].join(" ").toLocaleLowerCase();
    if (options.query && !searchable.includes(options.query.toLocaleLowerCase())) continue;
    const uniqueSelector = () => {
      if (id && CSS?.escape) {
        const byId = "#" + CSS.escape(id);
        if (document.querySelectorAll(byId).length === 1) return byId;
      }
      const parts = [];
      for (let node = element; node && node.nodeType === 1 && parts.length < 12; node = node.parentElement) {
        const siblings = node.parentElement
          ? Array.from(node.parentElement.children).filter((other) => other.tagName === node.tagName)
          : [node];
        parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")");
        const proposal = parts.join(" > ");
        if (document.querySelectorAll(proposal).length === 1) return proposal;
      }
      return null;
    };
    const path = uniqueSelector();
    if (!path) continue;
    let href;
    if (tag === "a") {
      try {
        const url = new URL(element.getAttribute("href") || "", location.href);
        if (url.protocol === "https:" || url.protocol === "http:") href = (url.origin + url.pathname).slice(0, 2000);
      } catch {}
    }
    results.push({
      tag, text: label, visible,
      enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true",
      selector: path,
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(type ? { type } : {}),
      ...(role ? { role } : {}),
      ...(href ? { href } : {}),
      ...(attr("target") ? { target: attr("target") } : {}),
      ...(attr("onclick") ? { onclickSignature: "inline-handler" } : {}),
      ...(attr("aria-label", 500) ? { ariaLabel: attr("aria-label", 500) } : {}),
      ...(attr("title", 500) ? { title: attr("title", 500) } : {}),
      ...(attr("alt", 500) ? { alt: attr("alt", 500) } : {}),
      ancestors: [],
    });
  }
  return { items: results, truncated: capped, totalCount: results.length };
}

async function domIndex(input, signal) {
  const start = performance.now();
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "domIndex", false);
  const graph = await inspectPersonalFrameGraph(chromeTabId);
  const framePath = input.framePath || [];
  const targets = [...graph.byId.values()].filter((entry) =>
    JSON.stringify(entry.path) === JSON.stringify(framePath));
  if (targets.length !== 1) {
    throw coded(targets.length ? "LOCATOR_AMBIGUOUS" : "FRAME_NOT_FOUND",
      "Frame path is not uniquely resolved in this Chrome tab.");
  }
  const frame = targets[0];
  if (!frame.data || frame.status !== "ready") {
    throw coded("FRAME_NOT_READY", "The selected Chrome frame is inaccessible or not ready.");
  }
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 500;
  if (!Number.isInteger(offset) || !Number.isInteger(limit) ||
      offset < 0 || offset > 1000000 || limit < 1 || limit > 2000) {
    throw coded("INVALID_ARGUMENT", "Invalid legacy DOM index pagination.");
  }
  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId, frameIds: [frame.frameId] },
      func: collectPersonalLegacyIndex,
      args: [frame.url, {
        rootSelector: input.rootSelector, query: input.query,
        visibleOnly: input.visibleOnly === true,
      }],
    });
  } catch {
    throw coded("FRAME_NOT_READY", "The selected document cannot be indexed.");
  }
  if (!result || result.frameId !== frame.frameId ||
      (frame.documentId && result.documentId !== frame.documentId) ||
      result.result?.stale) throw coded("FRAME_NOT_READY", "The frame navigated during indexing.");
  if (result.result?.invalidSelector) throw coded("INVALID_ARGUMENT", "Legacy root selector is not valid CSS.");
  if (result.result?.missing) throw coded("LOCATOR_NOT_FOUND", "Legacy index root selector did not match.");
  if (!Array.isArray(result.result?.items)) throw coded("FRAME_NOT_READY", "The frame returned an incomplete index.");
  const source = result.result.items;
  const profile = await profilePage({ tabId: input.tabId }, signal, graph);
  const seen = new Set();
  const items = source.slice(offset, offset + limit).map((item) => {
    const ref = "lref_" + personalLegacySignature([
      profile.pageSignature, profile.frameGraphSignature, frame.frameId, frame.documentId || "",
      item.selector, item.tag, item.type || "", item.role || "", item.text,
      item.href || "", item.enabled, item.visible,
    ]);
    if (seen.has(ref)) throw coded("LOCATOR_AMBIGUOUS", "Legacy element index ref collided.");
    seen.add(ref);
    return { ...item, ref, framePath: [...framePath] };
  });
  throwIfAborted(signal, "domIndex", false);
  return {
    tabId: input.tabId, framePath,
    pageSignature: profile.pageSignature, frameGraphSignature: profile.frameGraphSignature,
    items, truncated: Boolean(result.result.truncated || offset + limit < source.length),
    offset, totalCount: source.length,
    ...(offset + limit < source.length ? { nextOffset: offset + limit } : {}),
    telemetry: { totalMs: Math.max(0, performance.now() - start),
      frameResolutionMs: Math.max(0, performance.now() - start),
      indexMs: Math.max(0, performance.now() - start), candidateCount: source.length, retries: 0 },
  };
}

// Legacy frame step probe. Executed inside the selected document; no synthetic
// DOM mutations, no credential field values and no cross-frame DOM access.
// Mutation steps only resolve, describe and scroll their target here; the
// action itself is dispatched afterwards as trusted CDP input.
function probePersonalLegacyReadStep(expectedUrl, step, selector) {
  if (location.href !== expectedUrl) return { stale: true };
  const locator = step.locator;
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  };
  const buttonInput = (element) => element.tagName === "INPUT" &&
    ["submit", "button", "reset"].includes((element.getAttribute("type") || "").toLowerCase());
  const label = (element) =>
    (element.getAttribute("aria-label") || element.getAttribute("title") ||
      (buttonInput(element) ? element.value :
        element.tagName === "INPUT" && (element.getAttribute("type") || "").toLowerCase() === "image"
          ? element.getAttribute("alt") :
          ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
            ? element.getAttribute("placeholder") : (element.innerText || element.textContent)) ||
      "").trim();
  let candidates = [];
  if (locator) {
    try {
      if (selector) candidates = Array.from(document.querySelectorAll(selector));
      else if (locator.selector) candidates = Array.from(document.querySelectorAll(locator.selector));
      else if (locator.id) candidates = Array.from(document.querySelectorAll("[id]")).filter((e) => e.id === locator.id);
      else if (locator.name) candidates = Array.from(document.querySelectorAll("[name]")).filter((e) => e.getAttribute("name") === locator.name);
      else candidates = Array.from(document.querySelectorAll("button,a,input,textarea,select,summary,[role],[contenteditable],[onclick]")).slice(0, 2001);
    } catch { return { invalidSelector: true }; }
    if (candidates.length > 2000) return { ambiguous: true };
    candidates = candidates.filter((element) => {
      if (locator.id && element.id !== locator.id) return false;
      if (locator.name && element.getAttribute("name") !== locator.name) return false;
      if (locator.tag && element.tagName.toLowerCase() !== locator.tag.toLowerCase()) return false;
      if (locator.type && (element.getAttribute("type") || "").toLowerCase() !== locator.type.toLowerCase()) return false;
      if (locator.role && element.getAttribute("role") !== locator.role) return false;
      if (locator.target && element.getAttribute("target") !== locator.target) return false;
      if (locator.href && element.getAttribute("href") !== locator.href &&
          element.href !== locator.href) return false;
      if (locator.onclickSignature && !element.hasAttribute("onclick")) return false;
      if (locator.text) {
        const actual = label(element);
        if (locator.exact === false ? !actual.includes(locator.text) : actual !== locator.text) return false;
      }
      if (locator.ancestorText && !element.parentElement?.innerText?.includes(locator.ancestorText)) return false;
      return true;
    });
    if (step.rootSelector) {
      let root;
      try { root = document.querySelector(step.rootSelector); } catch { return { invalidSelector: true }; }
      candidates = root ? candidates.filter((element) => root.contains(element)) : [];
    }
    // A legacy menu cell with an onclick often wraps a link with the same
    // text; keep the innermost match instead of reporting ambiguity.
    if (locator.text) {
      candidates = candidates.filter((element) =>
        !candidates.some((other) => other !== element && element.contains(other)));
    }
    if (locator.index !== undefined) {
      candidates = candidates[locator.index] ? [candidates[locator.index]] : [];
    } else if (candidates.length > 1) return { ambiguous: true };
  }
  const element = locator ? candidates[0] : document.body;
  const exists = !!element;
  const isVisible = exists && visible(element);
  const enabled = exists && !element.disabled && element.getAttribute("aria-disabled") !== "true";
  const text = exists ? label(element).slice(0, 20000) : "";
  if (["click", "fill", "select", "press"].includes(step.action)) {
    if (!exists) return { found: false };
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    // The bridge classifies this descriptor with the shared dangerous-action
    // policy; it never contains field values.
    const target = {
      label: text.replace(/\\s+/gu, " ").slice(0, 200),
      role: element.getAttribute("role") || (type ? tag + ":" + type : tag),
      submitLike: type === "submit" || type === "image" ||
        (tag === "button" && (!type || type === "submit") && !!element.form),
    };
    if (step.describeOnly) return { found: true, target };
    if (!enabled) return { disabled: true };
    const editable = tag === "textarea" || element.isContentEditable || (tag === "input" &&
      !["file", "hidden", "submit", "button", "radio", "checkbox", "reset", "image", "range", "color"].includes(type));
    if (step.action === "fill" && (!editable || element.readOnly)) return { notEditable: true };
    let option;
    if (step.action === "select") {
      if (tag !== "select" || element.multiple) return { notEditable: true };
      const options = Array.from(element.options || []).slice(0, 1000);
      const matches = options.filter((candidate) => !candidate.disabled &&
        (candidate.value === step.value ||
          (candidate.textContent || "").replace(/\\s+/gu, " ").trim() === step.value));
      if (matches.length !== 1) return matches.length ? { ambiguous: true } : { missingOption: true };
      const chosen = options.indexOf(matches[0]);
      option = { value: matches[0].value,
        moves: options.slice(0, chosen).filter((candidate) => !candidate.disabled).length };
    }
    // "nearest" leaves visible targets alone; scrolling here can also scroll
    // ancestor frames asynchronously, which the bridge waits out when mapping.
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (!visible(element) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { invisible: true };
    const hit = document.elementFromPoint(x, y);
    if (hit !== element && !element.contains(hit)) return { obscured: true };
    // Remember the resolved element in this extension world only, so focus
    // and select results can be verified without re-resolving the locator.
    globalThis.__mcpV3LegacyActionTarget = element;
    return { found: true, target, point: { x, y }, editable,
      viewport: { width: innerWidth, height: innerHeight }, ...(option ? { option } : {}) };
  }
  const pageText = (document.body?.innerText || "").slice(0, 50000);
  const textMatches = !step.text || pageText.includes(step.text);
  const state = step.state || "exists";
  const satisfied = state === "ready" ? document.readyState !== "loading" :
    state === "hidden" ? !isVisible : state === "visible" ? isVisible : exists;
  if (step.action === "waitFor") return { found: exists, satisfied: satisfied && textMatches };
  if (step.action === "assert") {
    let asserted = false;
    if (step.condition === "frameReady") asserted = document.readyState !== "loading";
    else if (step.condition === "exists") asserted = exists;
    else if (step.condition === "visible") asserted = isVisible;
    else if (step.condition === "enabled") asserted = enabled;
    else if (step.condition === "textEquals") asserted = exists && text === step.expected;
    else if (step.condition === "textContains") asserted = exists && text.includes(step.expected);
    return { asserted };
  }
  if (!exists) return { found: false };
  const format = step.format || "text";
  const result = format === "html" ? element.outerHTML || element.innerHTML || "" :
    format === "json" ? { text, tag: element.tagName.toLowerCase() } :
      (element.innerText || element.textContent || "");
  if (JSON.stringify(result).length > 32000) return { tooLarge: true };
  return { found: true, value: result };
}

// Map a frame-local CSS point into the parent document. The host element is
// matched by the child's window name or URL plus its exact viewport size, so
// sibling frames cannot be confused; transformed, ambiguous or obscured hosts
// fail closed instead of producing a misdirected native click.
function probePersonalChildFramePoint(expectedUrl, child, localPoint, allowScroll) {
  if (location.href !== expectedUrl) return { stale: true };
  // Chrome sizes an out-of-process frame a moment after creating it. Until then
  // its viewport is empty: nothing in it can be measured, and scrolling it would
  // only move the page to a meaningless offset.
  if (!(innerWidth > 0 && innerHeight > 0)) return { unsized: true };
  const hosts = Array.from(document.querySelectorAll("iframe,frame")).slice(0, 200);
  let candidates = child.name ? hosts.filter((node) => node.getAttribute("name") === child.name) : [];
  if (candidates.length === 0) candidates = hosts.filter((node) => node.src === child.url);
  const metrics = (node) => {
    const style = getComputedStyle(node);
    return { style, rect: node.getBoundingClientRect(),
      padLeft: parseFloat(style.paddingLeft) || 0, padTop: parseFloat(style.paddingTop) || 0,
      width: node.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
      height: node.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0) };
  };
  const named = candidates;
  candidates = candidates.filter((node) => {
    const measured = metrics(node);
    return Math.abs(measured.width - child.width) <= 2 && Math.abs(measured.height - child.height) <= 2;
  });
  if (candidates.length !== 1) {
    return { ambiguous: candidates.length > 1, missing: candidates.length === 0,
      sizes: named.slice(0, 4).map((node) => {
        const measured = metrics(node);
        return Math.round(measured.width) + "x" + Math.round(measured.height);
      }) };
  }
  const host = candidates[0];
  const locate = () => {
    const measured = metrics(host);
    return { measured, x: measured.rect.left + host.clientLeft + measured.padLeft + localPoint.x,
      y: measured.rect.top + host.clientTop + measured.padTop + localPoint.y };
  };
  let point = locate();
  if (point.measured.style.transform !== "none" ||
      Math.abs(point.measured.rect.width - host.offsetWidth) > 2 ||
      Math.abs(point.measured.rect.height - host.offsetHeight) > 2) return { unsupported: true };
  if (allowScroll && (point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight)) {
    host.scrollIntoView({ block: "nearest", inline: "nearest" });
    point = locate();
  }
  if (point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight) {
    return { outside: true, at: Math.round(point.x) + "," + Math.round(point.y), size: innerWidth + "x" + innerHeight };
  }
  const covering = document.elementFromPoint(point.x, point.y);
  if (covering !== host) return { obscured: true, by: String(covering?.tagName || "nothing").toLowerCase().slice(0, 40) };
  return { x: point.x, y: point.y, viewport: { width: innerWidth, height: innerHeight } };
}

// Scrolls requested by a frame propagate to out-of-process ancestors
// asynchronously, so the chain is re-measured until two passes agree. Chrome
// gives a new out-of-process frame its size a moment after creating it, and on
// a busy machine that can take seconds: until then the frame reports an empty
// viewport and the mapping waits for it. A host still outside a sized frame's
// viewport has its ancestors scrolled to it from the top, and the mapping is
// retried for a moment before refusing.
async function resolvePersonalFramePoint(chromeTabId, graph, frame, localPoint, viewport, signal) {
  let previous;
  for (let outside = 0, unsized = 0; !previous;) {
    try {
      previous = await mapPersonalFramePoint(chromeTabId, graph, frame, localPoint, viewport, true);
    } catch (error) {
      if (error?.unsized && unsized < 100) unsized += 1;
      else if (error?.outsideViewport && outside < 10) outside += 1;
      else throw error;
      await revealPersonalFrameChain(chromeTabId, graph, frame);
      await delay(100, signal);
    }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await delay(50, signal);
    const point = await mapPersonalFramePoint(chromeTabId, graph, frame, localPoint, viewport, false);
    if (Math.abs(point.x - previous.x) <= 1 && Math.abs(point.y - previous.y) <= 1) return point;
    previous = point;
  }
  throw coded("STATE_NOT_REACHED", "Frame geometry did not settle; the page is still scrolling or animating.");
}

async function revealPersonalFrameChain(chromeTabId, graph, frame) {
  const chain = [];
  for (let current = frame; current.frameId !== 0 && chain.length < 16;) {
    const parent = graph.byId.get(current.parentFrameId);
    if (!parent) break;
    chain.unshift({ parent, child: current });
    current = parent;
  }
  for (const { parent, child } of chain) {
    await chrome.scripting.executeScript({
      target: { tabId: chromeTabId, frameIds: [parent.frameId] },
      func: revealPersonalChildFrame,
      args: [parent.url, { name: child.data?.name || "", url: child.url }],
    }).catch(() => undefined);
  }
}

// Only scrolls; the click point is still measured and verified afterwards.
function revealPersonalChildFrame(expectedUrl, child) {
  if (location.href !== expectedUrl || !(innerWidth > 0 && innerHeight > 0)) return false;
  const hosts = Array.from(document.querySelectorAll("iframe,frame")).slice(0, 200);
  let candidates = child.name ? hosts.filter((node) => node.getAttribute("name") === child.name) : [];
  if (candidates.length === 0) candidates = hosts.filter((node) => node.src === child.url);
  if (candidates.length !== 1) return false;
  candidates[0].scrollIntoView({ block: "center", inline: "center" });
  return true;
}

async function mapPersonalFramePoint(chromeTabId, graph, frame, localPoint, viewport, allowScroll) {
  let current = frame;
  let point = localPoint;
  let size = viewport;
  for (let depth = 0; current.frameId !== 0; depth += 1) {
    if (depth >= 16) throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Legacy frame nesting exceeds sixteen levels.");
    const parent = graph.byId.get(current.parentFrameId);
    if (!parent || parent.status !== "ready") {
      throw coded("FRAME_NOT_READY", "A parent frame is not scriptable, so its geometry cannot be verified.");
    }
    let mapped;
    try {
      [mapped] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId, frameIds: [parent.frameId] },
        func: probePersonalChildFramePoint,
        args: [parent.url, { name: current.data?.name || "", url: current.url,
          width: size.width, height: size.height }, point, allowScroll],
      });
    } catch {
      throw coded("FRAME_NOT_READY", "Parent frame geometry cannot be inspected.");
    }
    if (!mapped || mapped.frameId !== parent.frameId ||
        (parent.documentId && mapped.documentId !== parent.documentId) || mapped.result?.stale) {
      throw coded("FRAME_NOT_READY", "A parent frame navigated while mapping the action point.");
    }
    const result = mapped.result;
    if (result?.unsized) {
      const error = coded("FRAME_NOT_READY", "Chrome has not given a frame on the way to the target a size yet " +
        "(its viewport is 0x0), so the action point cannot be verified.");
      error.unsized = true;
      throw error;
    }
    if (!Number.isFinite(result?.x) || !Number.isFinite(result?.y)) {
      // Say which check failed, so a refusal in the user's Chrome can be diagnosed.
      const error = coded(result?.ambiguous ? "LOCATOR_AMBIGUOUS" : "BROWSER_CAPABILITY_UNSUPPORTED",
        result?.ambiguous ? "Several frame hosts match the frame's name or address and size." :
          result?.missing ? "No frame host matches the frame's name or address and its " + size.width + "x" +
            size.height + " size (found " + (result.sizes?.join(", ") || "none") + ")." :
            result?.outside ? "The frame host is outside the viewport even after scrolling (point " + result.at +
              ", viewport " + result.size + ")." :
              result?.obscured ? "Another element (" + result.by + ") covers the frame host at the action point." :
                "The frame host is transformed or scaled, so a native click could miss it.");
      error.outsideViewport = result?.outside === true;
      throw error;
    }
    point = { x: result.x, y: result.y };
    size = result.viewport;
    current = parent;
  }
  return point;
}

function verifyPersonalLegacyActionTarget(expectedUrl, mode, value) {
  if (location.href !== expectedUrl) return false;
  const element = globalThis.__mcpV3LegacyActionTarget;
  if (!element?.isConnected) return false;
  if (mode === "value") return element.value === value;
  if (mode === "scriptFocus") element.focus({ preventScroll: true });
  return document.activeElement === element ||
    (element.isContentEditable && element.contains(document.activeElement));
}

// Observe frame navigations caused by one action. Settling waits for every
// started navigation to finish, or for a short quiet period when none starts.
function watchPersonalFrameNavigations(chromeTabId) {
  const pending = new Set();
  let navigations = 0;
  const begin = (details) => {
    if (details.tabId !== chromeTabId) return;
    pending.add(details.frameId);
    navigations += 1;
  };
  const end = (details) => {
    if (details.tabId === chromeTabId) pending.delete(details.frameId);
  };
  chrome.webNavigation.onBeforeNavigate.addListener(begin);
  chrome.webNavigation.onCompleted.addListener(end);
  chrome.webNavigation.onErrorOccurred.addListener(end);
  return {
    async settle(deadline, signal, quietMs) {
      const quietUntil = Date.now() + quietMs;
      while (pending.size > 0 || (navigations === 0 && Date.now() < quietUntil)) {
        if (Date.now() >= deadline) {
          throw coded("STATE_NOT_REACHED", "A frame navigation started by a legacy action did not finish before the deadline.");
        }
        await delay(50, signal);
      }
    },
    dispose() {
      chrome.webNavigation.onBeforeNavigate.removeListener(begin);
      chrome.webNavigation.onCompleted.removeListener(end);
      chrome.webNavigation.onErrorOccurred.removeListener(end);
    },
  };
}

function personalLegacyEnter(key) {
  return String(key).trim().split(/\\s+/u).some((chord) =>
    /^(?:enter|return|numpadenter)$/iu.test(chord.split("+").pop().trim()));
}

// Resolve a mutation step's frame and target without acting. Frames that are
// still loading after an earlier step are awaited until waitUntil.
async function probePersonalLegacyTarget(input, chromeTabId, step, describeOnly, waitUntil, signal, started) {
  const framePath = step.framePath || [];
  while (true) {
    throwIfAborted(signal, "frameSequence", started);
    let graph;
    try { graph = await inspectPersonalFrameGraph(chromeTabId); }
    catch (error) {
      if (error?.code !== "FRAME_NOT_READY" || Date.now() >= waitUntil) throw error;
      await delay(150, signal);
      continue;
    }
    const matches = [...graph.byId.values()].filter((entry) =>
      JSON.stringify(entry.path) === JSON.stringify(framePath));
    if (matches.length !== 1 || matches[0].status !== "ready") {
      if (Date.now() >= waitUntil) throw coded("FRAME_NOT_READY", "Selected legacy frame is missing or inaccessible.");
      await delay(150, signal);
      continue;
    }
    const frame = matches[0];
    let selector;
    if (step.locator?.ref) {
      const fresh = await domIndex({ tabId: input.tabId, framePath, limit: 2000 }, signal);
      const refs = fresh.items.filter((item) => item.ref === step.locator.ref);
      if (refs.length !== 1) throw coded("LOCATOR_NOT_FOUND", "Legacy element reference is stale or invalid.");
      selector = refs[0].selector;
    }
    let observation;
    try {
      [observation] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId, frameIds: [frame.frameId] },
        func: probePersonalLegacyReadStep,
        args: [frame.url, { ...step, describeOnly }, selector ?? null],
      });
    } catch {
      throw coded("FRAME_NOT_READY", "Legacy frame document is not accessible.");
    }
    if (!observation || observation.frameId !== frame.frameId ||
        (frame.documentId && observation.documentId !== frame.documentId) ||
        observation.result?.stale) {
      throw coded("FRAME_NOT_READY", "Legacy frame navigated while resolving the action target.");
    }
    const observed = observation.result;
    if (observed?.invalidSelector) throw coded("INVALID_ARGUMENT", "Legacy locator selector is not valid.");
    if (observed?.ambiguous) throw coded("LOCATOR_AMBIGUOUS", "Legacy locator or option matched several candidates.");
    if (observed?.missingOption) throw coded("INVALID_ARGUMENT", "Requested select option does not exist.");
    if (!observed?.found) {
      throw coded("LOCATOR_NOT_FOUND", "Legacy action target is missing, disabled, obscured, outside the viewport or not editable.");
    }
    return { graph, frame, observed };
  }
}

// Describe every click/Enter target before any step runs, so the bridge can
// require confirmation for dangerous targets without a partial batch.
async function preflightPersonalLegacyTargets(input, chromeTabId, signal) {
  const targets = [];
  for (const [index, step] of input.steps.entries()) {
    const enter = step.action === "press" && personalLegacyEnter(step.key);
    if (step.action !== "click" && !enter) continue;
    if (!step.locator) {
      targets.push({ index, label: "keyboard:Enter", role: "keyboard", submitLike: true });
      continue;
    }
    let resolved;
    try {
      resolved = await probePersonalLegacyTarget(input, chromeTabId, step, true, Date.now(), signal, false);
    } catch (error) {
      if (!["FRAME_NOT_READY", "LOCATOR_NOT_FOUND"].includes(error?.code)) throw error;
      throw coded(error.code, "Click/Enter target of step " + index +
        " must exist when the sequence starts so it can be confirmed; split the sequence after navigation. " +
        String(error.message || ""));
    }
    targets.push({ index, ...resolved.observed.target });
  }
  return targets;
}

async function runPersonalLegacyMutation(input, chromeTabId, index, step, expected, deadline, signal, started) {
  const tab = await chrome.tabs.get(chromeTabId);
  if (tab.url !== input.guard.url) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The owned tab navigated away from the confirmed page.");
  }
  const enter = step.action === "press" && personalLegacyEnter(step.key);
  const keys = step.action === "press" ? String(step.key).trim().split(/\\s+/u).map(parseChromeKey) : [];
  if (keys.length > 100) throw coded("LIMIT_EXCEEDED", "Chrome key sequence exceeds 100 inputs.");
  const debuggee = { tabId: chromeTabId };
  let attached = false;
  let holding = false;
  let watcher;
  const release = async () => {
    if (!holding) return;
    holding = false;
    await detachGuardedDebugger(debuggee, attached).catch(() => undefined);
  };
  try {
    try {
      // A fresh attach shows Chrome's debugging infobar, which shrinks the page and
      // every frameset row; geometry is measured only once that settles, or native
      // input would land on stale coordinates.
      attached = await attachGuardedDebugger(debuggee);
      holding = true;
      if (attached || takeFreshPersonalDebugger(debuggee)) await settlePersonalViewport(debuggee, signal);
    } catch (error) {
      if (error?.code) throw error;
      throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Native legacy frame input is unavailable or the debugger is occupied.");
    }
    const resolved = step.action !== "press" || step.locator
      ? await probePersonalLegacyTarget(input, chromeTabId, step, false,
        Math.min(deadline, Date.now() + 10000), signal, started)
      : undefined;
    const observed = resolved?.observed;
    if (step.action === "click" || enter) {
      const target = observed?.target ?? { label: "keyboard:Enter", role: "keyboard", submitLike: true };
      if (!expected || expected.label !== target.label || expected.role !== target.role ||
          expected.submitLike !== target.submitLike) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "The legacy target of step " + index + " changed after preflight.");
      }
    }
    const point = resolved
      ? await resolvePersonalFramePoint(chromeTabId, resolved.graph, resolved.frame, observed.point,
        observed.viewport, signal)
      : undefined;
    // Input routed into an out-of-process frame is acknowledged before that
    // renderer applies it, so focus/value checks poll briefly before failing.
    const verify = async (mode, value) => {
      for (let attempt = 0; ; attempt += 1) {
        const [check] = await chrome.scripting.executeScript({
          target: { tabId: chromeTabId, frameIds: [resolved.frame.frameId] },
          func: verifyPersonalLegacyActionTarget, args: [resolved.frame.url, mode, value ?? null],
        });
        if (!check || check.frameId !== resolved.frame.frameId ||
            (resolved.frame.documentId && check.documentId !== resolved.frame.documentId)) return false;
        if (check.result === true) return true;
        if (attempt >= 10 || mode === "scriptFocus") return false;
        await delay(50, signal);
      }
    };
    watcher = watchPersonalFrameNavigations(chromeTabId);
    try {
      throwIfAborted(signal, "frameSequence", started);
      const current = await chrome.tabs.get(chromeTabId);
      if (current.url !== input.guard.url) {
        throw coded("BROWSER_CONFIRMATION_INVALID", "The owned tab navigated before native input.");
      }
      const dispatchKey = async (key) => {
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
          type: "keyDown", key: key.key, code: key.code,
          windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode,
          modifiers: key.modifiers, ...(key.text ? { text: key.text } : {}),
        });
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
          type: "keyUp", key: key.key, code: key.code,
          windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode,
          modifiers: key.modifiers,
        });
      };
      const clickPoint = async () => {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
            type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left",
            buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
          });
        }
      };
      if (step.action === "click") {
        await clickPoint();
      } else if (step.action === "fill") {
        await clickPoint();
        if (!(await verify("focus"))) throw coded("FRAME_NOT_READY", "The legacy field did not receive native focus.");
        await dispatchKey({ key: "a", code: "KeyA", keyCode: 65, modifiers: 2 });
        await dispatchKey({ key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 });
        await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text: step.value });
      } else if (step.action === "select") {
        if (!(await verify("value", observed.option.value))) {
          await clickPoint();
          await dispatchKey({ key: "Home", code: "Home", keyCode: 36, modifiers: 0 });
          for (let move = 0; move < observed.option.moves; move += 1) {
            throwIfAborted(signal, "frameSequence", true);
            await dispatchKey({ key: "ArrowDown", code: "ArrowDown", keyCode: 40, modifiers: 0 });
          }
          await dispatchKey({ key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 });
          if (!(await verify("value", observed.option.value))) {
            throw coded("STATE_NOT_REACHED", "The legacy select did not take the requested option.");
          }
        }
      } else {
        if (resolved) {
          if (observed.editable) await clickPoint();
          if (!(await verify(observed.editable ? "focus" : "scriptFocus"))) {
            throw coded("FRAME_NOT_READY", "The legacy key target did not receive focus.");
          }
        }
        for (const key of keys) {
          throwIfAborted(signal, "frameSequence", true);
          await dispatchKey(key);
        }
      }
    } catch (error) {
      if (error?.code) throw error;
      throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Native legacy frame input is unavailable or the debugger is occupied.");
    } finally {
      await release();
    }
    // Text entry rarely navigates; other actions get a short window to start one.
    await watcher.settle(deadline, signal, step.action === "fill" ? 0 : 400);
  } finally {
    await release();
    watcher?.dispose();
  }
  return { index, action: step.action, completed: true, strategy: "chrome-frame-native-input" };
}

async function frameSequence(input, signal) {
  const started = performance.now();
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 20) {
    throw coded("INVALID_ARGUMENT", "Legacy sequence requires one to twenty steps.");
  }
  const reads = ["index", "extract", "assert", "waitFor"];
  const mutations = input.steps.filter((step) => !reads.includes(step.action));
  if (mutations.some((step) => !["click", "fill", "select", "press"].includes(step.action))) {
    throw coded("INVALID_ARGUMENT", "Unknown legacy frame sequence action.");
  }
  // Mutations run only behind the bridge's page guard: a preflight call
  // describes every click/Enter target, and the execute call must observe the
  // same targets (now confirmed) before the first step runs.
  if (mutations.length > 0 && (!input.guard?.url ||
      (input.phase !== "preflight" && input.phase !== "execute"))) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Legacy frame mutations require a bridge page guard and preflight.");
  }
  const chromeTab = mutations.length > 0 ? await chrome.tabs.get(chromeTabId) : undefined;
  if (chromeTab && chromeTab.url !== input.guard.url) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The owned tab changed since the last snapshot.");
  }
  const targets = mutations.length > 0 ? await preflightPersonalLegacyTargets(input, chromeTabId, signal) : [];
  if (input.phase === "preflight") {
    return { tabId: input.tabId, completed: true,
      steps: targets.map(({ index, ...target }) => ({ index, action: input.steps[index].action,
        completed: true, value: target, strategy: "chrome-frame-preflight" })),
      telemetry: { totalMs: Math.max(0, performance.now() - started),
        strategy: "chrome-frame-preflight", retries: 0 } };
  }
  const expected = new Map((Array.isArray(input.expectedTargets) ? input.expectedTargets : [])
    .map((target) => [target.index, target]));
  if (expected.size !== targets.length || targets.some((target) => {
    const confirmed = expected.get(target.index);
    return !confirmed || confirmed.label !== target.label || confirmed.role !== target.role ||
      confirmed.submitLike !== target.submitLike;
  })) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Legacy click/Enter targets changed since preflight; nothing was executed.");
  }
  const timeout = Math.min(120000, Math.max(1, input.timeoutMs ?? 30000));
  const deadline = Date.now() + timeout;
  const done = [];
  let mutated = false;
  for (const [index, step] of input.steps.entries()) {
    throwIfAborted(signal, "frameSequence", mutated);
    if (Date.now() >= deadline) throw coded("STATE_NOT_REACHED", "Legacy frame sequence deadline exceeded.");
    const framePath = step.framePath || [];
    if (!reads.includes(step.action)) {
      mutated = true;
      try {
        done.push(await runPersonalLegacyMutation(input, chromeTabId, index, step,
          expected.get(index), deadline, signal, done.length > 0));
      } catch (error) {
        if (done.length === 0 || !error?.code) throw error;
        throw coded(error.code, error.message + " Completed step indexes: [" +
          done.map((item) => item.index).join(",") + "].");
      }
      continue;
    }
    if (step.action === "index") {
      const value = await domIndex({ tabId: input.tabId, framePath,
        rootSelector: step.rootSelector, query: step.query,
        offset: step.offset, limit: step.limit, visibleOnly: step.visibleOnly }, signal);
      done.push({ index, action: step.action, completed: true,
        value: { items: value.items, truncated: value.truncated, totalCount: value.totalCount },
        strategy: "chrome-web-navigation-index" });
      continue;
    }
    const waitDeadline = step.action === "waitFor"
      ? Math.min(deadline, Date.now() + (step.timeoutMs ?? 10000)) : deadline;
    while (true) {
      throwIfAborted(signal, "frameSequence", index > 0);
      if (Date.now() >= (step.action === "waitFor" ? waitDeadline : deadline)) {
        throw coded("STATE_NOT_REACHED", "Legacy frame state did not reach the requested condition.");
      }
      let graph;
      try { graph = await inspectPersonalFrameGraph(chromeTabId); }
      catch (error) {
        if (step.action !== "waitFor" || error?.code !== "FRAME_NOT_READY") throw error;
        await delay(150, signal);
        continue;
      }
      const candidates = [...graph.byId.values()].filter((entry) =>
        JSON.stringify(entry.path) === JSON.stringify(framePath));
      if (candidates.length !== 1 || candidates[0].status !== "ready") {
        if (step.action !== "waitFor") throw coded("FRAME_NOT_READY", "Selected legacy frame is missing or inaccessible.");
        await delay(150, signal);
        continue;
      }
      const frame = candidates[0];
      let selector;
      if (step.locator?.ref) {
        // Only lref_ values from the live frame index can resolve. Never
        // interpret a snapshot AX ref or a forged textual ref as an element.
        const fresh = await domIndex({ tabId: input.tabId, framePath, limit: 2000 }, signal);
        const matches = fresh.items.filter((item) => item.ref === step.locator.ref);
        if (matches.length !== 1) throw coded("LOCATOR_NOT_FOUND", "Legacy element reference is stale or invalid.");
        selector = matches[0].selector;
      }
      let observation;
      try {
        [observation] = await chrome.scripting.executeScript({
          target: { tabId: chromeTabId, frameIds: [frame.frameId] },
          func: probePersonalLegacyReadStep,
          args: [frame.url, step, selector ?? null],
        });
      } catch {
        if (step.action !== "waitFor") throw coded("FRAME_NOT_READY", "Legacy frame document is not accessible.");
        await delay(150, signal);
        continue;
      }
      if (!observation || observation.frameId !== frame.frameId ||
          (frame.documentId && observation.documentId !== frame.documentId) ||
          observation.result?.stale) {
        if (step.action !== "waitFor") throw coded("FRAME_NOT_READY", "Legacy frame navigated during observation.");
        await delay(150, signal);
        continue;
      }
      const observed = observation.result;
      if (observed?.invalidSelector) throw coded("INVALID_ARGUMENT", "Legacy locator selector is not valid.");
      if (observed?.ambiguous) throw coded("LOCATOR_AMBIGUOUS", "Legacy locator matched several elements.");
      if (observed?.tooLarge) throw coded("LIMIT_EXCEEDED", "Legacy extraction exceeds its bounded output.");
      if (step.action === "waitFor" && !observed?.satisfied) {
        await delay(150, signal);
        continue;
      }
      if (step.action === "assert" && !observed?.asserted) {
        throw coded("STATE_NOT_REACHED", "Legacy assertion failed at step " + index + ".");
      }
      if (step.action === "extract" && !observed?.found) {
        throw coded("LOCATOR_NOT_FOUND", "Legacy extraction target does not exist.");
      }
      done.push({ index, action: step.action, completed: true,
        ...(step.action === "extract" ? { value: observed.value } : {}),
        strategy: "chrome-frame-script-read" });
      break;
    }
  }
  return { tabId: input.tabId, completed: true, steps: done,
    telemetry: { totalMs: Math.max(0, performance.now() - started),
      strategy: mutated ? "chrome-frame-native-input" : "chrome-frame-readonly", retries: 0 } };
}

// Legacy menu paths. Each label is awaited (menus expand asynchronously),
// described and clicked with trusted input; a level whose next label is
// already visible is not clicked again, so an expanded menu is not collapsed.
// Form submit controls are refused unless the bridge confirmed the path.
async function navigatePath(input, signal) {
  const started = performance.now();
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  if (!input.guard?.url) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "Legacy navigation requires a bridge page guard.");
  }
  const tab = await chrome.tabs.get(chromeTabId);
  if (tab.url !== input.guard.url) {
    throw coded("BROWSER_CONFIRMATION_INVALID", "The owned tab changed since the last snapshot.");
  }
  const segmented = Array.isArray(input.segments) && input.segments.length > 0;
  const segments = segmented ? input.segments : [{ framePath: input.sourceFramePath || [], path: input.path,
    ...(input.targetFramePath ? { targetFramePath: input.targetFramePath } : {}) }];
  if (segments.length > 10 || segments.some((segment) => !Array.isArray(segment.path) || segment.path.length < 1) ||
      segments.reduce((total, segment) => total + segment.path.length, 0) > 10) {
    throw coded("INVALID_ARGUMENT", "A legacy path has one to ten levels in at most ten segments.");
  }
  const deadline = Date.now() + Math.min(120000, Math.max(1, input.timeoutMs ?? 60000));
  const remaining = () => Math.max(1, deadline - Date.now());
  const read = (step) => frameSequence({ tabId: input.tabId, steps: [step], timeoutMs: remaining() }, signal);
  const resolved = [];
  const segmentResults = [];
  let level = 0;
  let mutated = false;
  try {
    for (const [segmentIndex, segment] of segments.entries()) {
      const segmentStarted = performance.now();
      const framePath = segment.framePath || [];
      const scope = { framePath, ...(segment.rootSelector ? { rootSelector: segment.rootSelector } : {}) };
      for (const [position, label] of segment.path.entries()) {
        throwIfAborted(signal, "navigatePath", mutated);
        if (Date.now() >= deadline) throw coded("NAVIGATION_TIMEOUT", "Legacy navigation path exceeded its deadline.");
        await read({ action: "waitFor", ...scope, locator: { text: label }, state: "visible", timeoutMs: remaining() });
        let expanded = false;
        const next = segment.path[position + 1];
        if (next !== undefined) {
          try {
            await read({ action: "assert", ...scope, locator: { text: next }, condition: "visible" });
            expanded = true;
          } catch (error) {
            if (!["STATE_NOT_REACHED", "LOCATOR_NOT_FOUND", "LOCATOR_AMBIGUOUS"].includes(error?.code)) throw error;
          }
        }
        const step = { action: "click", ...scope, locator: { text: label } };
        const described = await probePersonalLegacyTarget(input, chromeTabId, step, true, Date.now(), signal, mutated);
        const target = described.observed.target;
        if (target.submitLike && input.authorized !== true) {
          throw coded("ACTION_BLOCKED_BY_POLICY", "Legacy path level " + level +
            " is a form submit control; use browser_frame_sequence so the submit can be confirmed.");
        }
        if (!expanded) {
          mutated = true;
          await runPersonalLegacyMutation(input, chromeTabId, level, step, target, deadline, signal, true);
        }
        resolved.push({ level, label,
          ref: "lpath_" + personalLegacySignature([framePath, level, label, target.role]),
          selector: (target.role + ":text=" + label).slice(0, 2000),
          strategy: expanded ? "already-expanded" : "chrome-frame-native-input",
          ...(segmented ? { segment: segmentIndex } : {}), framePath });
        level += 1;
      }
      if (segment.targetFramePath?.length) {
        await read({ action: "waitFor", framePath: segment.targetFramePath, state: "ready", timeoutMs: remaining() });
      }
      if (segment.waitFor) {
        const { timeoutMs, ...wait } = segment.waitFor;
        await read({ action: "waitFor", framePath: segment.targetFramePath || framePath, ...wait,
          timeoutMs: Math.min(timeoutMs ?? 10000, remaining()) });
      }
      segmentResults.push({ index: segmentIndex, framePath, path: segment.path,
        ...(segment.targetFramePath ? { targetFramePath: segment.targetFramePath } : {}),
        destinationReady: true,
        telemetry: { totalMs: Math.max(0, performance.now() - segmentStarted) } });
    }
    let checkpoint;
    if (input.checkpoint) {
      const checkpointStarted = performance.now();
      const observed = await read(input.checkpoint);
      checkpoint = { step: observed.steps[0],
        telemetry: { totalMs: Math.max(0, performance.now() - checkpointStarted) } };
    }
    return { tabId: input.tabId, completed: true, path: input.path, resolved, destinationReady: true,
      ...(segmented ? { segments: segmentResults } : {}),
      cache: { hit: false, revalidated: false, invalidated: false },
      ...(checkpoint ? { checkpoint } : {}),
      telemetry: { totalMs: Math.max(0, performance.now() - started),
        strategy: "chrome-frame-native-input", retries: 0 } };
  } catch (error) {
    if (!mutated || !error?.code) throw error;
    throw coded(error.code, error.message + " Completed path levels: [" +
      resolved.map((item) => item.level).join(",") + "].");
  }
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
  const history = await loadPersonalConsoleHistory(tabKey);
  try {
    await collectPersonalConsole(chromeTabId, history, signal);
  } catch (error) {
    if (signal?.aborted) throw cancellationError("console", signal, false);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger console capture is unavailable or occupied.");
  }
  const threshold = input.onlyErrors ? "error" : input.level;
  const severities = { error: 0, warning: 1, info: 2, debug: 3 };
  const output = history.entries.map((entry) => entry.line).filter((line) => {
    const level = line.slice(1, line.indexOf("]"));
    return (!threshold || (severities[level] ?? 3) <= severities[threshold]) &&
      (!filter || filter.test(line));
  });
  const text = output.slice(0, limit).join("\\n").slice(0, 120000);
  const result = {
    tabId: input.tabId, text,
    truncated: history.truncated || output.length > limit || output.join("\\n").length > 120000,
    collectedAt: new Date().toISOString(),
  };
  if (input.clear === true) await clearPersonalConsoleHistory(tabKey);
  else await savePersonalConsoleHistory(tabKey, history);
  return result;
}

const PERSONAL_CONSOLE_STORAGE_PREFIX = "mcpV3PersonalConsole:";
const PERSONAL_CONSOLE_MAX_ENTRIES = 500;

// Console history outlives service worker restarts (session storage, never
// disk) and navigations collected before MCP navigates the owned tab.
async function loadPersonalConsoleHistory(tabKey) {
  const cached = personalConsoleEntries.get(tabKey);
  if (cached) return cached;
  const storageKey = PERSONAL_CONSOLE_STORAGE_PREFIX + tabKey;
  const stored = await chrome.storage?.session?.get(storageKey).then((value) => value?.[storageKey], () => undefined);
  const entries = Array.isArray(stored?.entries)
    ? stored.entries.filter((entry) => typeof entry?.key === "string" && typeof entry?.line === "string")
      .slice(-PERSONAL_CONSOLE_MAX_ENTRIES)
    : [];
  const history = { entries, truncated: stored?.truncated === true };
  personalConsoleEntries.set(tabKey, history);
  return history;
}

async function savePersonalConsoleHistory(tabKey, history) {
  await chrome.storage?.session?.set({
    [PERSONAL_CONSOLE_STORAGE_PREFIX + tabKey]: { entries: history.entries, truncated: history.truncated },
  }).catch(() => undefined);
}

async function clearPersonalConsoleHistory(tabKey) {
  personalConsoleEntries.delete(tabKey);
  await chrome.storage?.session?.remove(PERSONAL_CONSOLE_STORAGE_PREFIX + tabKey).catch(() => undefined);
}

async function hasPersonalConsoleHistory(tabKey) {
  if (personalConsoleEntries.has(tabKey)) return true;
  const storageKey = PERSONAL_CONSOLE_STORAGE_PREFIX + tabKey;
  const stored = await chrome.storage?.session?.get(storageKey).then((value) => value?.[storageKey], () => undefined);
  return Boolean(stored);
}

// Collects the current document's console before MCP navigates a tab whose
// console was read earlier; failures never block the navigation itself.
async function preservePersonalConsole(chromeTabId, signal) {
  const tabKey = String(chromeTabId);
  if (!chrome.debugger?.onEvent?.addListener || !(await hasPersonalConsoleHistory(tabKey))) return;
  try {
    const history = await loadPersonalConsoleHistory(tabKey);
    await collectPersonalConsole(chromeTabId, history, signal);
    await savePersonalConsoleHistory(tabKey, history);
  } catch {
    // Best effort: an occupied debugger only loses the old document's lines.
  }
}

// Chrome replays the current document's stored console on Runtime/Log.enable;
// the original timestamps make repeated reads idempotent.
async function collectPersonalConsole(chromeTabId, history, signal) {
  const seen = new Set(history.entries.map((entry) => entry.key));
  let attached = false;
  const listener = (source, method, params) => {
    if (source?.tabId !== chromeTabId) return;
    let level;
    let message;
    let timestamp;
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
      timestamp = params?.timestamp;
    } else if (method === "Runtime.exceptionThrown") {
      level = "error";
      message = String(params?.exceptionDetails?.text ?? "Script exception");
      timestamp = params?.timestamp;
    } else if (method === "Log.entryAdded") {
      const entry = params?.entry;
      level = entry?.level === "error" ? "error" : entry?.level === "warning" ? "warning" :
        entry?.level === "verbose" ? "debug" : "info";
      message = String(entry?.text ?? "");
      timestamp = entry?.timestamp;
    } else return;
    const line = "[" + level + "] " + sanitizePersonalDiagnosticText(message.slice(0, 3000));
    const key = method + "|" + (Number.isFinite(timestamp) ? timestamp : "") + "|" + line;
    if (Number.isFinite(timestamp) && seen.has(key)) return;
    seen.add(key);
    if (history.entries.length >= PERSONAL_CONSOLE_MAX_ENTRIES) {
      history.entries.shift();
      history.truncated = true;
    }
    history.entries.push({ key, line });
  };
  try {
    chrome.debugger.onEvent.addListener(listener);
    const target = { tabId: chromeTabId };
    attached = await attachGuardedDebugger(target);
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
    await new Promise((resolve) => setTimeout(resolve, 120));
    throwIfAborted(signal, "console", false);
    personalConsoleEntries.set(String(chromeTabId), history);
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    // A debugger that stays attached replays the page's console on the next
    // enable only after a disable.
    if (!attached) {
      await chrome.debugger.sendCommand({ tabId: chromeTabId }, "Runtime.disable").catch(() => undefined);
      await chrome.debugger.sendCommand({ tabId: chromeTabId }, "Log.disable").catch(() => undefined);
    }
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
  if (state.attached !== true) {
    await chrome.debugger.sendCommand({ tabId: chromeTabId }, "Network.disable").catch(() => undefined);
  }
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
  if (input.dropRef && (input.inputRef || input.triggerRef || input.selector)) {
    throw coded("INVALID_ARGUMENT", "A drop zone upload cannot also target a file input.");
  }
  if (input.inputRef && input.guard.ref !== input.inputRef ||
      input.triggerRef && input.guard.ref !== input.triggerRef ||
      input.dropRef && input.guard.ref !== input.dropRef ||
      !input.inputRef && !input.triggerRef && !input.selector && !input.dropRef) {
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
    if (input.dropRef) {
      // Trusted CDP drag events carry the staged files onto the confirmed drop
      // zone; the page never receives a synthetic DataTransfer.
      let point;
      if (input.dropRef.startsWith("ax-")) {
        point = await resolveGuardedAxPoint(chromeTabId, input.dropRef, input.guard, target, false);
      } else {
        const [hit] = await chrome.scripting.executeScript({
          target: { tabId: chromeTabId }, func: probeGuardedElement,
          args: [input.dropRef, input.guard, false, null, null],
        });
        point = hit?.result;
        if (!point || point.error) {
          throw coded("BROWSER_CONFIRMATION_INVALID", "Drop zone is stale or obscured.");
        }
      }
      const data = { items: [], files: input.files.map((item) => item.path), dragOperationsMask: 19 };
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        throwIfAborted(signal, "upload", type === "drop");
        await chrome.debugger.sendCommand(target, "Input.dispatchDragEvent", {
          type, x: point.x, y: point.y, data,
        });
      }
      throwIfAborted(signal, "upload", true);
      return { tabId: input.tabId, completed: true, fileCount: input.files.length, totalBytes };
    }
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

// A recording captures the tab about four times a second while it is in front
// and streams each new picture to the bridge as a WebP still; the bridge
// assembles the video. Chrome's screencast can deliver a frame painted before
// the latest change, so every frame here is a fresh capture. A background tab
// adds no frames, and nothing is recorded while the user has the turn in the tab.
const PERSONAL_RECORDING_FRAME_MS = 200;
const personalRecordings = new Map();
globalThis.__mcpV3PersonalRecordings = personalRecordings;

async function startPersonalRecording(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "videoStart", false);
  if (typeof input.recordingId !== "string" || !/^[0-9a-f-]{36}$/u.test(input.recordingId)) {
    throw coded("INVALID_ARGUMENT", "A recording needs the bridge's recording id.");
  }
  const key = String(chromeTabId);
  const current = personalRecordings.get(key);
  if (current) {
    if (current.recordingId === input.recordingId) return { tabId: input.tabId, recordingId: input.recordingId, active: true };
    throw coded("EXECUTION_STATE_INVALID", "This tab is already being recorded.");
  }
  const fixed = Number.isInteger(input.width) && Number.isInteger(input.height) &&
    input.width >= 64 && input.width <= 3840 && input.height >= 64 && input.height <= 2160;
  const state = {
    recordingId: input.recordingId, chromeTabId, attached: false, borrowers: 0,
    width: fixed ? input.width : 0, height: fixed ? input.height : 0, canvas: null,
    timer: undefined, flight: Promise.resolve(), last: "",
  };
  const target = { tabId: chromeTabId };
  try {
    state.attached = await attachGuardedDebugger(target);
    personalRecordings.set(key, state);
    // The page as it is now opens the recording.
    state.flight = capturePersonalRecordingFrame(state);
    await state.flight;
    throwIfAborted(signal, "videoStart", true);
    schedulePersonalRecordingFrame(state);
    return { tabId: input.tabId, recordingId: input.recordingId, active: true };
  } catch (error) {
    endPersonalRecording(state, false);
    await detachGuardedDebugger(target, state.attached).catch(() => undefined);
    if (signal?.aborted) throw cancellationError("videoStart", signal, true);
    if (error?.code) throw error;
    throw coded("BROWSER_CAPABILITY_UNSUPPORTED", "Chrome debugger is unavailable for recording this tab.");
  }
}

function schedulePersonalRecordingFrame(state) {
  if (state.stopping) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (state.stopping) return;
    state.flight = state.flight.then(() => capturePersonalRecordingFrame(state)).catch(() => undefined)
      .finally(() => schedulePersonalRecordingFrame(state));
  }, PERSONAL_RECORDING_FRAME_MS);
}

async function capturePersonalRecordingFrame(state) {
  if (personalRecordings.get(String(state.chromeTabId)) !== state) return;
  const tab = await chrome.tabs.get(state.chromeTabId).catch(() => undefined);
  if (!tab?.active) return;
  const handoff = await readPersonalHandoff(state.chromeTabId);
  if (handoff && !handoff.done) return;
  const target = { tabId: state.chromeTabId };
  const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
  const view = metrics?.cssVisualViewport ?? metrics?.visualViewport;
  const width = Number(view?.clientWidth);
  const height = Number(view?.clientHeight);
  if (!(width > 0) || !(height > 0)) return;
  const scale = state.width
    ? Math.min(2, state.width / width, state.height / height)
    : Math.min(1, 1280 / width, 720 / height);
  const shot = await Promise.race([
    chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "jpeg", quality: 80, optimizeForSpeed: true,
      clip: { x: Number(view.pageX) || 0, y: Number(view.pageY) || 0, width, height, scale },
    }),
    delay(3000).then(() => undefined),
  ]);
  // An unchanged page captures to the same bytes; the video holds its last frame.
  if (typeof shot?.data !== "string" || shot.data === state.last) return;
  state.last = shot.data;
  await sendPersonalRecordingFrame(state, shot.data);
}

async function sendPersonalRecordingFrame(state, jpegBase64) {
  const bitmap = await createImageBitmap(new Blob([personalBase64Bytes(jpegBase64)], { type: "image/jpeg" }));
  try {
    if (!state.canvas) {
      // Every frame keeps the first frame's even size; later frames are letterboxed.
      if (!state.width) {
        state.width = Math.max(2, bitmap.width + (bitmap.width % 2));
        state.height = Math.max(2, bitmap.height + (bitmap.height % 2));
      }
      state.canvas = new OffscreenCanvas(state.width, state.height);
    }
    const context = state.canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#000";
    context.fillRect(0, 0, state.width, state.height);
    const scale = Math.min(state.width / bitmap.width, state.height / bitmap.height);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    context.drawImage(bitmap, Math.floor((state.width - width) / 2), Math.floor((state.height - height) / 2), width, height);
  } finally {
    bitmap.close();
  }
  const blob = await state.canvas.convertToBlob({ type: "image/webp", quality: 0.75 });
  if (personalRecordings.get(String(state.chromeTabId)) !== state) return;
  send({ type: "recording-frame", recordingId: state.recordingId,
    data: personalBytesBase64(new Uint8Array(await blob.arrayBuffer())) });
}

async function stopPersonalRecording(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  const key = String(chromeTabId);
  const state = personalRecordings.get(key);
  if (!state || state.recordingId !== input.recordingId) {
    return { tabId: input.tabId, recordingId: String(input.recordingId), active: false };
  }
  if (state.borrowers > 0) {
    throw coded("EXECUTION_STATE_INVALID",
      "The recording shares Chrome's debugger with a viewport, dialog or network capture; end that first.");
  }
  throwIfAborted(signal, "videoStop", false);
  state.stopping = true;
  clearTimeout(state.timer);
  state.timer = undefined;
  await state.flight.catch(() => undefined);
  // The page as it is now closes the recording.
  await capturePersonalRecordingFrame(state).catch(() => undefined);
  endPersonalRecording(state, false);
  await releasePersonalRecordingDebugger(state);
  return { tabId: input.tabId, recordingId: state.recordingId, active: false };
}

function endPersonalRecording(state, notify) {
  const key = String(state.chromeTabId);
  if (personalRecordings.get(key) !== state) return false;
  personalRecordings.delete(key);
  state.stopping = true;
  clearTimeout(state.timer);
  state.timer = undefined;
  if (notify) send({ type: "recording-ended", recordingId: state.recordingId });
  return true;
}

async function releasePersonalRecordingDebugger(state) {
  // A session that borrowed this recording's debugger keeps it attached.
  if (state.attached && state.borrowers > 0) return;
  await detachGuardedDebugger({ tabId: state.chromeTabId }, state.attached).catch(() => undefined);
}

// The bridge no longer wants this recording's frames.
function cancelPersonalRecording(recordingId) {
  for (const state of [...personalRecordings.values()]) {
    if (state.recordingId === recordingId && endPersonalRecording(state, false)) void releasePersonalRecordingDebugger(state);
  }
}

// Without the bridge nobody would receive the frames.
function endAllPersonalRecordings() {
  for (const state of [...personalRecordings.values()]) {
    if (endPersonalRecording(state, false)) void releasePersonalRecordingDebugger(state);
  }
}

function personalBase64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function personalBytesBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return btoa(binary);
}

async function screenshot(input, signal) {
  const chromeTabId = chromeTabIdFrom(input.tabId);
  await requireOwnedMetadata(chromeTabId);
  throwIfAborted(signal, "screenshot", false);
  const target = { tabId: chromeTabId };
  let attached = false;
  try {
    if (input.zoom !== undefined && !input.region) {
      throw coded("INVALID_ARGUMENT", "Zoom magnifies a clipped region; provide region.");
    }
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
      const zoom = input.zoom ?? 1;
      if (!Number.isFinite(zoom) || zoom < 1 || zoom > 8) {
        throw coded("INVALID_ARGUMENT", "Screenshot zoom must be between 1 and 8.");
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
      // Zoom renders the clip at a higher resolution, not an upscaled bitmap.
      scale *= zoom;
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
  await preservePersonalConsole(chromeTabId, signal);
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
  await preservePersonalConsole(chromeTabId, signal);
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
        shared: metadata.ownership === "user",
      }));
  });

  for (const target of targets) {
    axTargetsByTab.delete(target.chromeTabId);
    await finalizePersonalDialog(target.chromeTabId, true);
    await resetPersonalViewport(target.chromeTabId).catch(() => undefined);
    await releasePersonalTaskDebugger(target.chromeTabId);
    if (!target.shared) await clearPersonalHandoff(target.chromeTabId);
  }
  if (input.pause === true) return pausePersonalTask(input.taskId, targets);
  await closePersonalTaskHomes(input.taskId);
  await forgetMcpTaskGroups(input.taskId);
  if (input.keepOpen === true) {
    const groupedTabIds = [];
    for (const target of targets) {
      const current = await chrome.tabs.get(target.chromeTabId).catch(() => undefined);
      if (current && Number.isInteger(target.mcpGroupId) && current.groupId === target.mcpGroupId) {
        groupedTabIds.push(target.chromeTabId);
      }
    }
    if (groupedTabIds.length > 0) await chrome.tabs.ungroup(groupedTabIds);
    for (const target of targets) await clearPersonalHandoff(target.chromeTabId);
    for (const target of targets) if (target.shared) await setPersonalSharedBadge(target.chromeTabId, false);
    await notifyPersonalTaskFinished(input.taskId, 0, targets.length);
    await clearPersonalTaskQuestion(input.taskId).catch(() => undefined);
    await clearPersonalPlans(input.taskId);
    await clearPersonalTaskApprovals(input.taskId, targets.map((target) => target.chromeTabId));
    await withOwnershipLock(async () => {
      const owned = await readOwnedTabs();
      for (const target of targets) delete owned[String(target.chromeTabId)];
      await writeOwnedTabs(owned);
    });
    if (typeof input.taskId === "string") taskGroups.delete(input.taskId);
    else taskGroups.clear();
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

  // Tabs the user shared are released, never closed.
  const closing = targets.filter((target) => !target.shared);
  const released = targets.filter((target) => target.shared);
  for (const target of closing) {
    await chrome.tabs.remove(target.chromeTabId).catch(() => undefined);
  }
  for (const target of released) await releasePersonalSharedTab(target.chromeTabId);
  // A released tab leaves the finished task's group too: the group is the sharing boundary.
  const releasedGrouped = [];
  for (const target of released) {
    const current = await chrome.tabs.get(target.chromeTabId).catch(() => undefined);
    if (current && Number.isInteger(target.mcpGroupId) && current.groupId === target.mcpGroupId) {
      releasedGrouped.push(target.chromeTabId);
    }
  }
  if (releasedGrouped.length > 0) await chrome.tabs.ungroup(releasedGrouped).catch(() => undefined);
  await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    for (const target of targets) delete owned[String(target.chromeTabId)];
    await writeOwnedTabs(owned);
  });
  if (typeof input.taskId === "string") taskGroups.delete(input.taskId);
  else taskGroups.clear();
  await notifyPersonalTaskFinished(input.taskId, closing.length, released.length);
  await clearPersonalTaskQuestion(input.taskId).catch(() => undefined);
  await clearPersonalPlans(input.taskId);
  await clearPersonalTaskApprovals(input.taskId, targets.map((target) => target.chromeTabId));
  return {
    completed: true,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    closedTabs: closing.length,
    closedTabIds: closing.map((target) => target.tabId),
    ...(released.length > 0 ? { releasedTabs: released.length,
      releasedTabIds: released.map((target) => target.tabId) } : {}),
    browserClosed: false,
  };
}

const MCP_TASK_GROUP_COLORS = ["blue", "green", "purple", "cyan", "orange", "pink", "red", "yellow"];
const MAX_MCP_GROUP_LABEL_CHARS = 24;

// Each task group gets its own label and color so two tasks never look like
// the same "MCP" group.
function mcpTaskGroupStyle(taskId, label) {
  let text = typeof label === "string" ? label.trim() : "";
  try {
    const url = new URL(text);
    if (url.hostname) text = url.hostname.replace(/^www[.]/u, "");
  } catch {
    // A free-text purpose is used as written.
  }
  if (text.length > MAX_MCP_GROUP_LABEL_CHARS) text = text.slice(0, MAX_MCP_GROUP_LABEL_CHARS - 1).trimEnd() + "…";
  let hash = 0;
  for (const char of taskId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return {
    title: text ? "MCP · " + text : "MCP",
    color: MCP_TASK_GROUP_COLORS[hash % MCP_TASK_GROUP_COLORS.length],
  };
}

// Grouping is cosmetic: a failure is reported as no group, never as a failed open.
async function assignMcpTaskGroup(chromeTabId, taskId, owned, label) {
  const persistedGroupId = Object.values(owned || {})
    .find((metadata) => metadata?.taskId === taskId && Number.isInteger(metadata?.mcpGroupId))
    ?.mcpGroupId;
  const existingGroupId = taskGroups.get(taskId) ?? persistedGroupId;
  if (Number.isInteger(existingGroupId)) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: chromeTabId, groupId: existingGroupId });
      taskGroups.set(taskId, groupId);
      await rememberMcpGroup(groupId, taskId);
      return groupId;
    } catch {
      taskGroups.delete(taskId);
    }
  }
  let groupId;
  try {
    groupId = await chrome.tabs.group({ tabIds: chromeTabId });
  } catch {
    return undefined;
  }
  try {
    await chrome.tabGroups.update(groupId, mcpTaskGroupStyle(taskId, label));
  } catch {
    // The tab is grouped even when Chrome refuses the title or color.
  }
  taskGroups.set(taskId, groupId);
  await rememberMcpGroup(groupId, taskId);
  return groupId;
}

// The task's tab group is its sharing boundary, as in Claude's own browser
// tool: a tab the user drags into an MCP group is shared with that task, a tab
// a task page opens there belongs to the task, and any tab dragged out of the
// group goes back to the user, still open. The approved plan still bounds what
// MCP may do in any of them.
const PERSONAL_GROUP_TASKS_KEY = "mcpV3GroupTasks";
const PERSONAL_TASK_HOMES_KEY = "mcpV3TaskHomes";
const PERSONAL_PENDING_SHARES_KEY = "mcpV3PendingShares";
const PERSONAL_CONFIRM_DRAG_KEY = "mcpV3ConfirmDragShare";
const MAX_PERSONAL_TASK_TABS = 20;
const PERSONAL_PAUSE_LIMIT_MS = 24 * 60 * 60 * 1000;
const PERSONAL_PAUSED_SUFFIX = " (em espera)";
// The group a popup share starts is keyed by this prefix and is no task.
const PERSONAL_POPUP_SHARE_PREFIX = "shared-";
// Tabs the extension itself is opening or regrouping: their group change is not the user's.
const pendingMcpTabs = new Set();

async function readSessionMap(key) {
  const value = await chrome.storage.session.get(key).catch(() => ({}));
  const map = value?.[key];
  return map && typeof map === "object" ? map : {};
}

async function changeSessionMap(key, change) {
  const map = await readSessionMap(key);
  change(map);
  await chrome.storage.session.set({ [key]: map });
}

async function rememberMcpGroup(groupId, taskId) {
  await changeSessionMap(PERSONAL_GROUP_TASKS_KEY, (groups) => { groups[String(groupId)] = taskId; })
    .catch(() => undefined);
}

async function mcpGroupTask(groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) return undefined;
  const known = (await readSessionMap(PERSONAL_GROUP_TASKS_KEY))[String(groupId)];
  if (typeof known === "string") return known;
  // After a worker restart the owned tabs still name their group, but only a
  // tab that is still in it counts: Chrome reuses group ids after a restart.
  for (const [key, metadata] of Object.entries(await readOwnedTabs())) {
    if (metadata?.mcpGroupId !== groupId || typeof metadata.taskId !== "string") continue;
    const tab = await chrome.tabs.get(Number(key)).catch(() => undefined);
    if (tab?.groupId === groupId) return metadata.taskId;
  }
  return undefined;
}

async function forgetMcpTaskGroups(taskId) {
  await changeSessionMap(PERSONAL_GROUP_TASKS_KEY, (groups) => {
    for (const [groupId, owner] of Object.entries(groups)) if (taskId === undefined || owner === taskId) delete groups[groupId];
  }).catch(() => undefined);
}

function countPersonalTaskTabs(owned, taskId) {
  return Object.values(owned).filter((metadata) => metadata?.taskId === taskId).length;
}

function enforcePersonalTaskTabLimit(owned, taskId) {
  if (countPersonalTaskTabs(owned, taskId) >= MAX_PERSONAL_TASK_TABS) {
    throw coded("LIMIT_EXCEEDED", "Task " + taskId + " already has " + MAX_PERSONAL_TASK_TABS +
      " tabs. Reuse one with browser_navigate or close one before opening another.");
  }
}

function followPersonalTabGroup(chromeTabId, groupId) {
  if (pendingMcpTabs.has(chromeTabId)) return Promise.resolve();
  return enqueueMutation("group:" + chromeTabId, async () => {
    if (pendingMcpTabs.has(chromeTabId)) return;
    if (Object.values(await readSessionMap(PERSONAL_TASK_HOMES_KEY)).includes(chromeTabId)) return;
    // Events can arrive late, after MCP regrouped the tab: act on its group now.
    const live = await chrome.tabs.get(chromeTabId).catch(() => undefined);
    if (!live) return;
    if (Number.isInteger(live.groupId)) groupId = live.groupId;
    const groupTask = await mcpGroupTask(groupId);
    const metadata = (await readOwnedTabs())[String(chromeTabId)];
    if (metadata) {
      if (Number.isInteger(metadata.mcpGroupId) && metadata.mcpGroupId === groupId) return;
      if (typeof metadata.taskId === "string" && metadata.taskId === groupTask) return;
      if (!Number.isInteger(metadata.mcpGroupId)) {
        // A tab shared from the popup outside any group joins the group it is
        // dragged into; any other tab that sat in no group stays as it is.
        if (metadata.ownership === "user" && metadata.taskId === undefined && groupTask) {
          await attachSharedTabToTask(chromeTabId, groupTask, groupId);
        }
        return;
      }
      // Only a tab that sat in its task's group can leave it.
      await releasePersonalGroupTab(chromeTabId, metadata);
    }
    await changeSessionMap(PERSONAL_PENDING_SHARES_KEY, (shares) => { delete shares[String(chromeTabId)]; })
      .catch(() => undefined);
    if (groupTask) await joinPersonalTaskGroup(chromeTabId, groupTask, groupId);
  }).catch(() => undefined);
}

function isPopupShareGroup(taskId) {
  return typeof taskId === "string" && taskId.startsWith(PERSONAL_POPUP_SHARE_PREFIX);
}

async function attachSharedTabToTask(chromeTabId, taskId, groupId) {
  await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    const metadata = owned[String(chromeTabId)];
    if (!metadata) return;
    owned[String(chromeTabId)] = { ...metadata,
      ...(isPopupShareGroup(taskId) ? {} : { taskId }), mcpGroupId: groupId };
    await writeOwnedTabs(owned);
  });
}

async function releasePersonalGroupTab(chromeTabId, metadata) {
  if (metadata.ownership === "user") {
    await releasePersonalSharedTab(chromeTabId);
    return;
  }
  axTargetsByTab.delete(chromeTabId);
  await finalizePersonalDialog(chromeTabId, true);
  await resetPersonalViewport(chromeTabId).catch(() => undefined);
  await clearPersonalHandoff(chromeTabId);
  await removeOwnedTab(chromeTabId);
  await clearPersonalTabApprovals(chromeTabId);
}

async function joinPersonalTaskGroup(chromeTabId, taskId, groupId) {
  const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
  if (!tab) return;
  const now = new Date().toISOString();
  const httpUrl = typeof tab.url === "string" && /^https?:/u.test(tab.url) ? tab.url : undefined;
  const child = await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    const opener = Number.isInteger(tab.openerTabId) ? owned[String(tab.openerTabId)] : undefined;
    if (opener?.ownership !== "mcp" || opener.taskId !== taskId) return false;
    if (countPersonalTaskTabs(owned, taskId) >= MAX_PERSONAL_TASK_TABS) return undefined;
    // A page of the task opened this tab: it is the task's, held to the same plan.
    owned[String(chromeTabId)] = {
      tabId: PERSONAL_PREFIX + chromeTabId, taskId, lifecycle: "task-scoped", ownership: "mcp",
      purpose: "Aba aberta por uma página da tarefa", reusable: false, protected: false, sticky: false,
      mcpGroupId: groupId, createdAt: now, lastUsedAt: now, ...(httpUrl ? { requestedUrl: httpUrl } : {}),
    };
    await writeOwnedTabs(owned);
    return true;
  });
  if (child === true) return;
  if (child === undefined) {
    await refusePersonalGroupShare(chromeTabId, "A tarefa já tem " + MAX_PERSONAL_TASK_TABS + " abas.");
    return;
  }
  try {
    assertPersonalNavigationTarget(tab.url);
  } catch {
    await refusePersonalGroupShare(chromeTabId, "Endereço privado, local ou página interna do Chrome.");
    return;
  }
  const title = await mcpGroupTitle(groupId);
  if (await personalDragShareNeedsConfirmation()) {
    // The answer is given in the extension popup, the one place for MCP V3 controls.
    await changeSessionMap(PERSONAL_PENDING_SHARES_KEY, (shares) => {
      shares[String(chromeTabId)] = { taskId, groupId, title };
    });
    await Promise.resolve(chrome.action?.setBadgeText?.({ tabId: chromeTabId, text: "?" })).catch(() => undefined);
    await notifyPersonalShare(chromeTabId, "Compartilhar esta aba com " + title + "?",
      "Abra o MCP V3 nesta aba para confirmar.");
    return;
  }
  if (await sharePersonalTabWithTask(chromeTabId, taskId, groupId)) {
    await notifyPersonalShare(chromeTabId, "Aba compartilhada com " + title,
      String(tab.title || "").slice(0, 120) + " Para parar, tire a aba do grupo ou use o MCP V3.");
  }
}

async function sharePersonalTabWithTask(chromeTabId, taskId, groupId) {
  const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
  if (!tab || tab.groupId !== groupId) return false;
  let url;
  try {
    url = assertPersonalNavigationTarget(tab.url);
  } catch {
    return false;
  }
  const shared = await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    if (owned[String(chromeTabId)] || countPersonalTaskTabs(owned, taskId) >= MAX_PERSONAL_TASK_TABS) return false;
    const now = new Date().toISOString();
    owned[String(chromeTabId)] = {
      tabId: PERSONAL_PREFIX + chromeTabId, ...(isPopupShareGroup(taskId) ? {} : { taskId }),
      lifecycle: "external", ownership: "user",
      purpose: "Aba compartilhada pelo usuário", reusable: false, protected: true, sticky: false,
      mcpGroupId: groupId, createdAt: now, lastUsedAt: now, requestedUrl: url,
    };
    await writeOwnedTabs(owned);
    return true;
  });
  if (shared) await setPersonalSharedBadge(chromeTabId, true);
  return shared;
}

async function readPendingPersonalShare(chromeTabId) {
  return (await readSessionMap(PERSONAL_PENDING_SHARES_KEY))[String(chromeTabId)];
}

// Only the user answers, from the extension popup: share it, or take it back out of the group.
async function answerPersonalShare(chromeTabId, share) {
  const pending = await readPendingPersonalShare(chromeTabId);
  await changeSessionMap(PERSONAL_PENDING_SHARES_KEY, (shares) => { delete shares[String(chromeTabId)]; })
    .catch(() => undefined);
  await Promise.resolve(chrome.notifications?.clear?.("mcp-share:" + chromeTabId)).catch(() => undefined);
  if (pending && share && await sharePersonalTabWithTask(chromeTabId, pending.taskId, pending.groupId)) return;
  await setPersonalSharedBadge(chromeTabId, false);
  await chrome.tabs.ungroup(chromeTabId).catch(() => undefined);
}

async function refusePersonalGroupShare(chromeTabId, reason) {
  await chrome.tabs.ungroup(chromeTabId).catch(() => undefined);
  await notifyPersonalShare(chromeTabId, "Esta aba não pode ficar no grupo do MCP", reason);
}

// Only a heads-up: every answer is given in the extension popup.
async function notifyPersonalShare(chromeTabId, title, message) {
  await Promise.resolve(chrome.notifications?.create?.("mcp-share:" + chromeTabId, {
    type: "basic", iconUrl: PERSONAL_NOTIFICATION_ICON, title, message: message || " ", priority: 1,
  })).catch(() => undefined);
}

async function personalDragShareNeedsConfirmation() {
  const value = await chrome.storage.local.get(PERSONAL_CONFIRM_DRAG_KEY).catch(() => ({}));
  return value?.[PERSONAL_CONFIRM_DRAG_KEY] === true;
}

async function mcpGroupTitle(groupId) {
  const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
  const title = String(group?.title || "MCP");
  return title.endsWith(PERSONAL_PAUSED_SUFFIX) ? title.slice(0, -PERSONAL_PAUSED_SUFFIX.length) : title;
}

// Chrome has no empty groups: approving a plan for a task with no tab yet opens
// the task's first tab, a page of this extension, and starts its group with it.
async function preparePersonalTaskGroup(plan) {
  const owned = await readOwnedTabs();
  if (Object.values(owned).some((metadata) => metadata?.taskId === plan.taskId)) return;
  const homes = await readSessionMap(PERSONAL_TASK_HOMES_KEY);
  if (Number.isInteger(homes[plan.taskId]) && await chrome.tabs.get(homes[plan.taskId]).catch(() => undefined)) return;
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  const home = await chrome.tabs.create({
    url: chrome.runtime.getURL("task-home.html#" + encodeURIComponent(plan.taskId)), active: true,
    ...(Number.isInteger(window?.id) ? { windowId: window.id } : {}),
  }).catch(() => undefined);
  if (!Number.isInteger(home?.id)) return;
  await changeSessionMap(PERSONAL_TASK_HOMES_KEY, (map) => { map[plan.taskId] = home.id; });
  await assignMcpTaskGroup(home.id, plan.taskId, owned, plan.summary);
}

// The first browser_open of a task navigates its first tab instead of opening another.
async function takePersonalTaskHome(taskId, targetUrl) {
  const homes = await readSessionMap(PERSONAL_TASK_HOMES_KEY);
  const homeId = homes[taskId];
  if (!Number.isInteger(homeId)) return undefined;
  await changeSessionMap(PERSONAL_TASK_HOMES_KEY, (map) => { delete map[taskId]; });
  const current = await chrome.tabs.get(homeId).catch(() => undefined);
  if (!current || !String(current.url || current.pendingUrl || "").startsWith(chrome.runtime.getURL("task-home.html"))) {
    return undefined;
  }
  pendingMcpTabs.add(homeId);
  return chrome.tabs.update(homeId, { url: targetUrl, active: true }).catch(() => {
    pendingMcpTabs.delete(homeId);
    return undefined;
  });
}

async function closePersonalTaskHomes(taskId) {
  const homes = await readSessionMap(PERSONAL_TASK_HOMES_KEY);
  const closing = Object.entries(homes).filter(([owner]) => taskId === undefined || owner === taskId);
  if (closing.length === 0) return;
  await changeSessionMap(PERSONAL_TASK_HOMES_KEY, (map) => { for (const [owner] of closing) delete map[owner]; });
  for (const [, homeId] of closing) await chrome.tabs.remove(homeId).catch(() => undefined);
}

async function personalTaskHomeDispatch(message) {
  if (message.type !== "mcp-home-get" || typeof message.taskId !== "string") throw Error("unsupported");
  const plan = Object.values(await readPersonalPlans())
    .filter((candidate) => candidate.taskId === message.taskId && candidate.status === "approved")
    .sort((left, right) => right.decidedAt - left.decidedAt)[0];
  if (!plan) throw Error("missing");
  return { ok: true, title: mcpTaskGroupStyle(plan.taskId, plan.summary).title, summary: plan.summary,
    domains: plan.approvedDomains };
}

// A paused task keeps its tabs in its group, collapsed, until the agent comes
// back with a new approved plan for it (or, when no plan is required, with
// browser_open for it). Nothing acts in a paused tab before that.
async function pausePersonalTask(taskId, targets) {
  const pausedAt = new Date().toISOString();
  await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    for (const target of targets) {
      const metadata = owned[String(target.chromeTabId)];
      if (metadata) owned[String(target.chromeTabId)] = { ...metadata, paused: true, pausedAt };
    }
    await writeOwnedTabs(owned);
  });
  await stylePersonalTaskGroups(targets.map((target) => target.chromeTabId), true);
  await closePersonalTaskHomes(taskId);
  await clearPersonalPlans(taskId);
  await clearPersonalTaskApprovals(taskId, targets.map((target) => target.chromeTabId));
  return {
    completed: true, taskId, closedTabs: 0, closedTabIds: [],
    pausedTabs: targets.length, pausedTabIds: targets.map((target) => target.tabId), browserClosed: false,
  };
}

async function resumePersonalTask(taskId) {
  const resumed = await withOwnershipLock(async () => {
    const owned = await readOwnedTabs();
    const ids = [];
    for (const [key, metadata] of Object.entries(owned)) {
      if (metadata?.taskId !== taskId || metadata.paused !== true) continue;
      const { paused: _paused, pausedAt: _pausedAt, ...active } = metadata;
      owned[key] = { ...active, lastUsedAt: new Date().toISOString() };
      ids.push(Number(key));
    }
    if (ids.length > 0) await writeOwnedTabs(owned);
    return ids;
  });
  if (resumed.length > 0) await stylePersonalTaskGroups(resumed, false);
  return resumed.length;
}

async function stylePersonalTaskGroups(chromeTabIds, paused) {
  const groupIds = new Set();
  for (const chromeTabId of chromeTabIds) {
    const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
    if (Number.isInteger(tab?.groupId) && tab.groupId >= 0) groupIds.add(tab.groupId);
  }
  for (const groupId of groupIds) {
    const title = await mcpGroupTitle(groupId);
    await chrome.tabGroups.update(groupId, paused
      ? { collapsed: true, title: title + PERSONAL_PAUSED_SUFFIX }
      : { collapsed: false, title }).catch(() => undefined);
  }
}

async function refusePausedPersonalTab(operation, input) {
  if (["tabs", "plan", "open", "closeTab", "finishTask"].includes(operation) || typeof input?.tabId !== "string") return;
  let chromeTabId;
  try {
    chromeTabId = chromeTabIdFrom(input.tabId);
  } catch {
    return;
  }
  const metadata = (await readOwnedTabs())[String(chromeTabId)];
  if (metadata?.paused !== true) return;
  throw coded("ACTION_BLOCKED_BY_POLICY", "Task " + metadata.taskId + " is paused. Call browser_plan for it " +
    "(or browser_open with its taskId when no plan is required) to resume its tabs.");
}

// Paused tasks nobody came back to close after a day, like a finished task.
async function sweepPausedPersonalTasks() {
  const cutoff = Date.now() - PERSONAL_PAUSE_LIMIT_MS;
  const expired = new Set(Object.values(await readOwnedTabs())
    .filter((metadata) => metadata?.paused === true && Date.parse(metadata.pausedAt) < cutoff)
    .map((metadata) => metadata.taskId));
  for (const taskId of expired) if (typeof taskId === "string") await finishTask({ taskId }).catch(() => undefined);
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
  await clearPersonalConsoleHistory(String(chromeTabId));
  await stopPersonalNetworkCapture(chromeTabId);
  personalNetworkEntries.delete(String(chromeTabId));
  await releasePersonalTaskDebugger(chromeTabId);
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
  const { mcpGroupId: _mcpGroupId, lockedUrl: _lockedUrl, generatedTaskId: _generatedTaskId,
    pausedAt: _pausedAt, ...publicMetadata } = metadata;
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
  const x = coordinateX == null ? rect.left + rect.width / 2 : coordinateX;
  const y = coordinateY == null ? rect.top + rect.height / 2 : coordinateY;
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
    Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34],
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

function extractPage(ref, selector, format, expectedUrl) {
  if (expectedUrl !== undefined && location.href !== expectedUrl) return { found: false, stale: true };
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
  // Safe pagination navigates the owned tab, so it waits behind its mutations.
  if (operation === "extract" && input?.completion === "document-and-safe-pagination" &&
      typeof input?.tabId === "string") return "tab:" + input.tabId;
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

if (chrome.runtime.onMessage?.addListener && chrome.storage?.session) chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof message?.type !== "string" || !message.type.startsWith("mcp-tab-")) return false;
  // Only the extension's own popup, never a page, the bridge or another extension.
  if (sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL("secret-provision.html")) return false;
  void personalTabSharingDispatch(message).then(
    (result) => reply(result),
    () => reply({ ok: false, code: "refused" }),
  );
  return true;
});

if (chrome.runtime.onMessage?.addListener && chrome.storage?.session) chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof message?.type !== "string" || !message.type.startsWith("mcp-plan-")) return false;
  // Only the plan window the extension opened, never a page, the bridge or another extension.
  if (sender.id !== chrome.runtime.id ||
      String(sender.url).split("#")[0] !== chrome.runtime.getURL("plan-review.html")) return false;
  void personalPlanReviewDispatch(message).then(
    (result) => reply(result),
    () => reply({ ok: false, code: "refused" }),
  );
  return true;
});
chrome.windows?.onRemoved?.addListener((windowId) => void rejectPersonalPlanWindow(windowId));
if (chrome.runtime.onMessage?.addListener && chrome.storage?.session) chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "mcp-home-get") return false;
  // Only the task's first tab, a page of this extension.
  if (sender.id !== chrome.runtime.id ||
      String(sender.url).split("#")[0] !== chrome.runtime.getURL("task-home.html")) return false;
  void personalTaskHomeDispatch(message).then(
    (result) => reply(result),
    () => reply({ ok: false, code: "refused" }),
  );
  return true;
});

chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (typeof changeInfo?.groupId === "number") void followPersonalTabGroup(tabId, changeInfo.groupId);
});
// A tab a page opens from a grouped tab is born in that group.
chrome.tabs.onCreated?.addListener?.((tab) => {
  if (Number.isInteger(tab?.id) && Number.isInteger(tab.groupId) && tab.groupId >= 0) {
    void followPersonalTabGroup(tab.id, tab.groupId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  personalViewportSessions.delete(String(tabId));
  void changeSessionMap(PERSONAL_TASK_HOMES_KEY, (homes) => {
    for (const [taskId, homeId] of Object.entries(homes)) if (homeId === tabId) delete homes[taskId];
  }).catch(() => undefined);
  void changeSessionMap(PERSONAL_PENDING_SHARES_KEY, (shares) => { delete shares[String(tabId)]; }).catch(() => undefined);
  const recording = personalRecordings.get(String(tabId));
  if (recording) endPersonalRecording(recording, true);
  void removeOwnedTab(tabId);
  void chrome.storage.session.remove(PERSONAL_HANDOFF_PREFIX + tabId).catch(() => undefined);
  void Promise.resolve(chrome.notifications?.clear?.("mcp-handoff:" + tabId)).catch(() => undefined);
  void clearPersonalTabApprovals(tabId);
});
// A notification button is Chrome UI: only the user can press it.
chrome.notifications?.onButtonClicked?.addListener((id) => {
  const match = /^mcp-handoff:(\\d+)$/u.exec(id);
  if (match) void resumePersonalHandoff(Number(match[1]));
  const approval = /^mcp-approval:(\\d+)$/u.exec(id);
  if (approval) void grantPersonalSiteApproval(Number(approval[1]));
});
chrome.notifications?.onClicked?.addListener((id) => {
  if (id.startsWith("mcp-plan:")) {
    void readPersonalPlans().then((plans) => {
      const windowId = plans[id.slice("mcp-plan:".length)]?.windowId;
      return Number.isInteger(windowId) ? chrome.windows.update(windowId, { focused: true }) : undefined;
    }).catch(() => undefined);
    return;
  }
  if (id.startsWith("mcp-question:")) {
    void Promise.resolve(chrome.action?.openPopup?.()).catch(() => undefined);
    return;
  }
  const match = /^mcp-(?:handoff|approval|share):(\\d+)$/u.exec(id);
  if (!match) return;
  void chrome.tabs.update(Number(match[1]), { active: true })
    .then((tab) => chrome.windows.update(tab.windowId, { focused: true }))
    .catch(() => undefined);
});
chrome.debugger?.onDetach?.addListener((source) => {
  const key = String(source?.tabId);
  const held = personalTaskDebuggers.get(key);
  if (held) {
    clearTimeout(held.timer);
    personalTaskDebuggers.delete(key);
  }
  personalViewportSessions.delete(key);
  const recording = personalRecordings.get(key);
  if (recording) endPersonalRecording(recording, true);
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
// Plans and MCP tabs change in many places; the plan's navigation rules follow both.
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "session" && changes[PERSONAL_PLANS_KEY]) || (area === "local" && changes[OWNED_TABS_KEY])) {
    void syncPersonalPlanNavigationRules();
  }
});
void syncPersonalPlanNavigationRules();
chrome.alarms?.create?.("mcp-paused-sweep", { periodInMinutes: 30 });
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === "mcp-paused-sweep") void sweepPausedPersonalTasks();
});
void sweepPausedPersonalTasks();
connect();
`;

  return { manifest, serviceWorker, popupHtml: HANDOFF_POPUP_HTML, popupScript: HANDOFF_POPUP_SCRIPT,
    tabSharingScript: TAB_SHARING_POPUP_SCRIPT, planReviewHtml: PLAN_REVIEW_HTML, planReviewScript: PLAN_REVIEW_SCRIPT,
    taskHomeHtml: TASK_HOME_HTML, taskHomeScript: TASK_HOME_SCRIPT };
}
