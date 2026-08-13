import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpBenchmarkClient } from "../mcp/mcp-client.mjs";
import {
  BrowserBenchmarkOperationError,
  startIsolatedBrowserWorker,
  startIsolatedGateway,
} from "./browser-benchmark-runtime.mjs";
import {
  assertDevOperationAllowed,
  buildExecutionSchedule,
  classifyDevStability,
  DEV_FLOW_IDS,
  sanitizedGridSignature,
  summarizeFlowSamples,
  validateDevConfig,
  validateFlowPostcondition,
} from "./flow-benchmark-core.mjs";
import {
  extractToolResult,
  mcpCall as callVsCodeMcp,
} from "./flow-benchmark-local.mjs";

const MENU_PATH = ["Financeiro", "CPX-Finance"];
const HOME_LABEL = "Novidades (Home)";
const HOME_ROOT_SELECTOR = "#DataClosed3 font";
const CONTENT_FRAME = ["MenuContent"];
const DEV_PANELS = [
  { label: "Confer\u00eancias", view: "CONFERENCIAS" },
  { label: "Pend\u00eancias", view: "PENDENCIAS" },
  { label: "Hist\u00f3rico", view: "HISTORICO" },
];

export async function runDevFlowSuite(options) {
  const rawConfig = JSON.parse(
    (await readFile(options.devConfigPath, "utf8")).replace(/^\uFEFF/u, ""),
  );
  const config = validateDevConfig(rawConfig);
  await assertProfileDirectories(config.profiles);
  const schedule = buildExecutionSchedule({
    warmups: options.warmups,
    iterations: options.iterations,
  });
  let previousWorker;
  let candidateWorker;
  let gateway;
  let vscode;
  try {
    [previousWorker, candidateWorker] = await Promise.all([
      startIsolatedBrowserWorker({
        label: "dev-previous",
        root: options.previousRoot,
        scratchDirectory: options.scratchDirectory,
        profileDirectory: config.profiles.previous,
        browserChannel: "chromium",
      }),
      startIsolatedBrowserWorker({
        label: "dev-candidate",
        root: options.candidateRoot,
        scratchDirectory: options.scratchDirectory,
        profileDirectory: config.profiles.candidate,
        browserChannel: "chromium",
      }),
    ]);
    gateway = await startIsolatedGateway({
      root: options.candidateRoot,
      worker: candidateWorker,
      mode: options.gatewayMode,
      scratchDirectory: path.join(options.scratchDirectory, "gateway-private"),
    });
    const manualAuthenticationResult = options.devAuthSignalPath
      ? await waitForManualDevAuthentication({
          signalPath: options.devAuthSignalPath,
          previousCall: previousWorker.call,
          candidateCall: candidateWorker.call,
          url: config.url,
        })
      : { mode: "preexisting-profile", verifiedEngines: [], tabIds: {} };
    const manualAuthentication = {
      mode: manualAuthenticationResult.mode,
      verifiedEngines: manualAuthenticationResult.verifiedEngines,
    };
    const authenticatedTabs = manualAuthenticationResult.tabIds ?? {};
    const authenticatedMenuStructures = manualAuthenticationResult.menuStructures ?? {};
    const previousNavigationState = { structure: authenticatedMenuStructures.previous };
    const candidateNavigationState = { structure: authenticatedMenuStructures.candidate };
    vscode = await createDevVsCodeAdapter({
      config,
      pageId: options.vscodePageId,
      runtimePath: options.vscodeRuntimePath,
    });
    const adapters = {
      previous: {
        optimized: createDevWorkerAdapter("previous", previousWorker.call, config, {
          tabId: authenticatedTabs.previous,
          navigationState: previousNavigationState,
        }),
      },
      candidate: {
        optimized: createDevWorkerAdapter("candidate", candidateWorker.call, config, {
          tabId: authenticatedTabs.candidate,
          navigationState: candidateNavigationState,
        }),
        gateway: createDevWorkerAdapter("candidate-gateway", gateway.call, config, {
          tabId: authenticatedTabs.candidate,
          navigationState: candidateNavigationState,
        }),
      },
      vscode: {
        individual: vscode,
        batch: vscode,
      },
    };
    await runDevPreflight({
      previous: adapters.previous.optimized,
      candidate: adapters.candidate.optimized,
      vscode,
      config,
    });
    const flows = {};
    for (const flowId of DEV_FLOW_IDS) {
      const raw = {
        previous: { optimized: [] },
        candidate: { optimized: [], gateway: [] },
        vscode: { individual: [], batch: [] },
      };
      for (const scheduled of schedule) {
        for (const engine of scheduled.order) {
          const pathNames = engine === "candidate"
            ? (scheduled.index % 2 === 0 ? ["optimized", "gateway"] : ["gateway", "optimized"])
            : engine === "vscode"
              ? (scheduled.index % 2 === 0 ? ["individual", "batch"] : ["batch", "individual"])
              : ["optimized"];
          for (const pathName of pathNames) {
            const sample = await adapters[engine][pathName].run(flowId, {
              phase: scheduled.phase,
              sample: scheduled.sample,
              scheduleIndex: scheduled.index,
              pathName,
            });
            if (!sample.success) {
              throw new Error(
                `Dev flow ${flowId} failed its exact postcondition on ${engine}/${pathName}.`,
              );
            }
            raw[engine][pathName].push({
              ...sample,
              engineOrder: [...scheduled.order],
              path: pathName,
            });
          }
        }
      }
      flows[flowId] = summarizeDevFlow(raw, options.warmups);
      await delay(1_000);
    }
    const current = {
      runId: options.runId,
      capturedAt: options.capturedAt,
      suite: "dev",
      source: options.source,
      flows,
      safety: {
        functionalErrors: 0,
        writeAttempts: 0,
        authenticationBreaks: 0,
      },
    };
    const history = await readDevHistory(options.historyDirectory);
    return {
      mode: "read-only-observational",
      config: {
        url: config.url,
        profiles: Object.fromEntries(
          Object.entries(config.profiles).map(([engine, profilePath]) => [
            engine,
            { basename: path.basename(profilePath), sha256: pathSignature(profilePath) },
          ]),
        ),
        windowDays: config.windowDays,
        rowLimit: config.rowLimit,
      },
      preflight: {
        domain: new URL(config.url).hostname,
        environment: "dev",
        authorizedGroupEvidence:
          "The dedicated profile could resolve the CPX-Finance menu item and read-only queue header.",
        forbiddenActions: "blocked by a static allowlist and never present in executable flow steps",
      },
      methodology: {
        manualAuthentication,
        concurrency: 1,
        minimumIntervalBetweenFlowsMs: 1_000,
        rowContentPersisted: false,
        stopOnFunctionalError: true,
      },
      transport: {
        gatewayRuntime: gateway.provenance,
      },
      flows,
      safety: current.safety,
      stability: classifyDevStability(current, history),
    };
  } finally {
    await vscode?.close().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    await Promise.all([
      previousWorker?.close().catch(() => undefined),
      candidateWorker?.close().catch(() => undefined),
    ]);
  }
}

export function createDevWorkerAdapter(name, call, config, options = {}) {
  const fixedTabId = typeof options.tabId === "string" ? options.tabId : undefined;
  const navigationState = options.navigationState ?? {};
  const acquireTab = async (purpose) => fixedTabId
    ? { tabId: fixedTabId, shouldClose: false }
    : {
        tabId: await openDevTab(call, config.url, purpose),
        shouldClose: true,
      };
  const getMenuStructure = async (tabId) => {
    navigationState.structure ??= await resolveCpxMenuStructure(call, tabId);
    return navigationState.structure;
  };
  return {
    name,
    async preflight() {
      const { tabId, shouldClose } = await acquireTab(`${name}-preflight`);
      try {
        const profile = await call("profilePage", { tabId, maxDepth: 8 });
        assertExpectedFrames(profile);
        const menuStructure = await getMenuStructure(tabId);
        await ensureCpxReady(call, tabId, menuStructure);
        await ensureConferencesPanel(call, tabId);
        return true;
      } finally {
        if (shouldClose) await call("closeTab", { tabId }).catch(() => undefined);
      }
    },
    async run(flowId, context) {
      const { tabId, shouldClose } = await acquireTab(
        `${name}-${flowId}-${context.scheduleIndex}-${context.pathName}`,
      );
      try {
        const menuStructure = await getMenuStructure(tabId);
        switch (flowId) {
          case "cpx-finance-open":
            await ensureDevHome(call, tabId, menuStructure);
            return await runDevOpen(call, tabId, context, menuStructure);
          case "cpx-finance-refresh":
            await ensureCpxReady(call, tabId, menuStructure);
            await ensureConferencesPanel(call, tabId);
            return await runDevRefresh(call, tabId, config, context);
          case "cpx-finance-navigation":
            await ensureCpxReady(call, tabId, menuStructure);
            await ensureConferencesPanel(call, tabId);
            return await runDevNavigation(call, tabId, context);
          case "cpx-finance-grid":
            await ensureCpxReady(call, tabId, menuStructure);
            await ensureConferencesPanel(call, tabId);
            await executeSafeRefresh(call, tabId, config, "setup");
            await waitForCpxReady(call, tabId, { minimumDelayMs: 250 });
            await waitForGridReady(call, tabId);
            return await runDevGrid(call, tabId, config, context);
          default:
            throw new Error(`Unsupported Dev flow: ${flowId}.`);
        }
      } finally {
        if (shouldClose) await call("closeTab", { tabId }).catch(() => undefined);
      }
    },
  };
}

async function runDevPreflight({ previous, candidate, vscode, config }) {
  assertDevOperationAllowed({
    path: MENU_PATH,
    actions: ["Atualizar", "ConferÃªncias", "PendÃªncias", "HistÃ³rico"],
  });
  if (
    config.windowDays !== 7 ||
    config.rowLimit !== 20 ||
    new URL(config.url).hostname.toLocaleLowerCase("en-US").includes("production")
  ) {
    throw new Error("Dev preflight rejected an unsafe environment or filter boundary.");
  }
  await previous.preflight();
  await candidate.preflight();
  await vscode.preflight();
}

async function runDevOpen(call, tabId, context, menuStructure) {
  const measured = await measure(context, async (meter) => {
    const navigation = await navigateMeasuredCpx(meter, call, tabId, menuStructure);
    return { navigation };
  });
  const page = await waitForCpxReady(call, tabId);
  const observation = {
    environment: "dev",
    header: page.header,
    filters: page.filters,
    resultsArea: page.resultsArea,
  };
  return finalize("cpx-finance-open", measured, observation, measured.value.navigation.telemetry);
}

async function runDevRefresh(call, tabId, config, context) {
  const measured = await executeSafeRefresh(call, tabId, config, context.phase);
  const page = await waitForCpxReady(call, tabId, { minimumDelayMs: 250 });
  const observation = {
    environment: "dev",
    windowDays: config.windowDays,
    rowCount: page.rowCount,
    accountPreserved: measured.accountBefore === measured.accountAfter,
  };
  return finalize("cpx-finance-refresh", measured, observation, measured.telemetry);
}

async function runDevNavigation(call, tabId, context) {
  const panels = [];
  const measured = await measure(context, async (meter) => {
    for (const panel of DEV_PANELS) {
      assertDevOperationAllowed(panel.label);
      const selector = `button.finc-fila-view-tab[onclick*="'${panel.view}'"]`;
      const activeSelector = `button.finc-fila-view-tab.is-active[onclick*="'${panel.view}'"]`;
      await waitForDevPanelTarget(meter, call, tabId, selector);
      await confirmedFrameSequence(meter, call, {
        tabId,
        steps: [{
          action: "click",
          framePath: CONTENT_FRAME,
          locator: { selector },
        }],
      });
      const active = await waitForDevPanelActive(meter, call, tabId, activeSelector);
      if (!normalize(active).includes(normalize(panel.label))) {
        throw new Error(`Dev panel did not become active: ${panel.label}.`);
      }
      panels.push(panel.label);
    }
    return { panels };
  });
  return finalize("cpx-finance-navigation", measured, { panels }, {
    strategy: "confirmed-read-only-tab-postbacks",
  });
}

export async function waitForDevPanelTarget(meter, call, tabId, selector, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const pollMs = options.pollMs ?? 50;
  let lastTransientError;
  while (Date.now() < deadline) {
    try {
      const result = await meter.call(call, "frameSequence", {
        tabId,
        steps: [{
          action: "assert",
          framePath: CONTENT_FRAME,
          locator: { selector },
          condition: "exists",
        }],
      });
      if (result.steps[0]?.completed === true) return { ready: true };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : undefined;
      if (![
        "INTERNAL_ERROR",
        "FRAME_NOT_FOUND",
        "FRAME_NOT_READY",
        "LOCATOR_NOT_FOUND",
        "STATE_NOT_REACHED",
      ].includes(code)) {
        throw error;
      }
      lastTransientError = error;
    }
    await delay(pollMs);
  }
  throw new Error("Dev panel target did not become available before the deadline.", {
    ...(lastTransientError === undefined ? {} : { cause: lastTransientError }),
  });
}

export async function waitForDevPanelActive(meter, call, tabId, selector, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const pollMs = options.pollMs ?? 50;
  let lastTransientError;
  while (Date.now() < deadline) {
    try {
      const result = await meter.call(call, "frameSequence", {
        tabId,
        steps: [{
          action: "extract",
          framePath: CONTENT_FRAME,
          locator: { selector },
          format: "text",
        }],
      });
      if (result.steps[0]?.completed === true) {
        return String(result.steps[0]?.value ?? "");
      }
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : undefined;
      if (![
        "INTERNAL_ERROR",
        "FRAME_NOT_FOUND",
        "FRAME_NOT_READY",
        "LOCATOR_NOT_FOUND",
        "STATE_NOT_REACHED",
      ].includes(code)) {
        throw error;
      }
      lastTransientError = error;
    }
    await delay(pollMs);
  }
  throw new Error("Dev panel did not become active before the deadline.", {
    ...(lastTransientError === undefined ? {} : { cause: lastTransientError }),
  });
}

async function runDevGrid(call, tabId, config, context) {
  const measured = await measure(context, async (meter) => {
    const countText = await meter.call(call, "frameSequence", {
      tabId,
      steps: [
        {
          action: "extract",
          framePath: CONTENT_FRAME,
          locator: { selector: ".finc-fila-load-count" },
          format: "text",
        },
        {
          action: "extract",
          framePath: CONTENT_FRAME,
          locator: { selector: ".finc-fila-table" },
          format: "text",
        },
      ],
    });
    return { result: countText };
  });
  const countText = String(measured.value.result.steps[0]?.value ?? "");
  const tableText = String(measured.value.result.steps[1]?.value ?? "");
  const rowCount = Math.min(parseLoadedCount(countText), config.rowLimit);
  const signature = sanitizedGridSignature(tableText, rowCount);
  const observation = rowCount === 0
    ? { empty: true, rowCount: 0 }
    : { empty: false, rowCount, sha256: signature.sha256 };
  return finalize("cpx-finance-grid", measured, observation, {
    strategy: "sanitized-compact-grid-index",
  });
}

async function executeSafeRefresh(call, tabId, config, phase) {
  const { startDate, endDate } = safeDateWindow(config.windowDays);
  const accountBefore = await extractText(call, tabId, "#IN4");
  const baseInput = {
    tabId,
    steps: [
      {
        action: "fill",
        framePath: CONTENT_FRAME,
        locator: { id: "IN2" },
        value: startDate,
      },
      {
        action: "fill",
        framePath: CONTENT_FRAME,
        locator: { id: "IN3" },
        value: endDate,
      },
      {
        action: "fill",
        framePath: CONTENT_FRAME,
        locator: { id: "IN5" },
        value: String(config.rowLimit),
      },
      {
        action: "click",
        framePath: CONTENT_FRAME,
        locator: { selector: ".finc-fila-filter-refresh" },
      },
      {
        action: "waitFor",
        framePath: CONTENT_FRAME,
        locator: { selector: ".finc-fila-load-count" },
        state: "visible",
        timeoutMs: 30_000,
      },
      {
        action: "extract",
        framePath: CONTENT_FRAME,
        locator: { id: "IN4" },
        format: "text",
      },
    ],
  };
  assertDevOperationAllowed(baseInput);
  const measured = await measure({ phase }, async (meter) => {
    const result = await confirmedFrameSequence(meter, call, baseInput);
    return { result };
  });
  return {
    ...measured,
    accountBefore,
    accountAfter: String(measured.value.result.steps[5]?.value ?? ""),
    telemetry: measured.value.result.telemetry,
  };
}

async function confirmedFrameSequence(meter, call, input) {
  const startedAt = performance.now();
  let confirmation;
  try {
    const result = await meter.call(call, "frameSequence", input);
    meter.protocolDurationMs = round(performance.now() - startedAt);
    return result;
  } catch (error) {
    if (!(error instanceof BrowserBenchmarkOperationError)) throw error;
    if (error.code !== "ACTION_REQUIRES_CONFIRMATION") throw error;
    confirmation = parseConfirmation(error.message);
  }
  const riskyIndex = Number(confirmation?.target?.stepIndex ?? confirmation?.stepIndex);
  const clickIndex = input.steps.findIndex((step) => step.action === "click");
  const index = Number.isInteger(riskyIndex) ? riskyIndex : clickIndex;
  const confirmed = {
    ...input,
    steps: input.steps.map((step, stepIndex) =>
      stepIndex === index ? { ...step, confirmationId: confirmation.confirmationId } : step
    ),
  };
  const result = await meter.call(call, "frameSequence", confirmed);
  meter.protocolDurationMs = round(performance.now() - startedAt);
  return result;
}

async function navigateToCpx(call, tabId, menuStructure) {
  const structure = menuStructure ?? await resolveCpxMenuStructure(call, tabId);
  return executeDeterministicCpxNavigation(call, tabId, structure);
}

function isRecoverableNavigationCompletionError(error) {
  return [
    "INTERNAL_ERROR",
    "FRAME_NOT_FOUND",
    "FRAME_NOT_READY",
    "STATE_NOT_REACHED",
    "NAVIGATION_TIMEOUT",
  ].includes(error?.code);
}

async function executeDeterministicCpxNavigation(call, tabId, structure) {
  const startedAt = performance.now();
  const recoveries = [];
  try {
    await call("frameClick", {
      tabId,
      frame: "Menu",
      selector: structure.financeClickSelector,
      index: structure.financeClickIndex,
    });
  } catch (error) {
    if (!isRecoverableNavigationCompletionError(error)) throw error;
    recoveries.push({ phase: "finance", code: error.code });
  }
  await call("frameSequence", {
    tabId,
    steps: [{
      action: "waitFor",
      framePath: ["Menu"],
      locator: {
        selector: structure.cpxVisibleLinkSelector,
        text: "CPX-Finance",
        exact: true,
      },
      state: "visible",
      timeoutMs: 15_000,
    }],
  });
  try {
    await call("frameClick", {
      tabId,
      frame: "Menu",
      selector: structure.cpxClickSelector,
      index: structure.cpxClickIndex,
    });
  } catch (error) {
    if (!isRecoverableNavigationCompletionError(error)) throw error;
    recoveries.push({ phase: "cpx", code: error.code });
  }
  await waitForCpxReady(call, tabId);
  const totalMs = round(performance.now() - startedAt);
  return {
    completed: true,
    path: MENU_PATH,
    resolved: [
      {
        level: 0,
        label: "Financeiro",
        selector: structure.financeClickSelector,
        strategy: "selector-index",
      },
      {
        level: 1,
        label: "CPX-Finance",
        selector: structure.cpxClickSelector,
        strategy: "selector-index",
      },
    ],
    destinationReady: true,
    cache: {
      hit: false,
      revalidated: false,
      invalidated: false,
    },
    ...(recoveries.length === 0 ? {} : { recoveries }),
    telemetry: {
      totalMs,
      navigationMs: totalMs,
      strategy: recoveries.length === 0
        ? "deterministic-selector-index-frame-clicks"
        : "postcondition-recovered-selector-index-frame-clicks",
    },
  };
}

export async function navigateMeasuredCpx(meter, call, tabId, menuStructure) {
  const meteredCall = (operation, input) => meter.call(call, operation, input);
  const structure = menuStructure ?? await resolveCpxMenuStructure(meteredCall, tabId);
  return executeDeterministicCpxNavigation(meteredCall, tabId, structure);
}

export async function ensureCpxReady(call, tabId, menuStructure) {
  if (await isCpxReady(call, tabId)) return { alreadyReady: true };
  const structure = menuStructure ?? await resolveCpxMenuStructure(call, tabId);
  const setupMeter = {
    call: async (targetCall, operation, input) => targetCall(operation, input),
    protocolDurationMs: 0,
  };
  await ensureFinanceMenuCollapsed(setupMeter, call, tabId, structure);
  return navigateToCpx(call, tabId, structure);
}
export async function ensureConferencesPanel(call, tabId) {
  const expected = DEV_PANELS[0].label;
  const activeBefore = await extractText(call, tabId, ".finc-fila-view-tab.is-active");
  if (normalize(activeBefore).includes(normalize(expected))) {
    return { alreadyActive: true };
  }
  const setupMeter = {
    call: async (targetCall, operation, input) => targetCall(operation, input),
    protocolDurationMs: 0,
  };
  await confirmedFrameSequence(setupMeter, call, {
    tabId,
    steps: [
      {
        action: "click",
        framePath: CONTENT_FRAME,
        locator: { text: expected, exact: true },
      },
      {
        action: "waitFor",
        framePath: CONTENT_FRAME,
        locator: { selector: ".finc-fila-view-tab.is-active" },
        text: expected,
        state: "visible",
        timeoutMs: 20_000,
      },
    ],
  });
  const activeAfter = await extractText(call, tabId, ".finc-fila-view-tab.is-active");
  if (!normalize(activeAfter).includes(normalize(expected))) {
    throw new Error("CPX-Finance could not restore the ConferÃªncias panel.");
  }
  return { changed: true };
}

export async function waitForGridReady(call, tabId) {
  return call("frameSequence", {
    tabId,
    steps: [
      {
        action: "waitFor",
        framePath: CONTENT_FRAME,
        locator: { selector: ".finc-fila-table" },
        state: "visible",
        timeoutMs: 30_000,
      },
    ],
  });
}

export async function waitForCpxReady(call, tabId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const startedAt = Date.now();
  const notBefore = startedAt + (options.minimumDelayMs ?? 0);
  const deadline = startedAt + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const page = await readCpxState(call, tabId);
      if (page.header && page.filters && Date.now() >= notBefore) return page;
    } catch (error) {
      if (!isExpectedCpxAbsence(error)) throw error;
      lastError = error;
    }
    await delay(pollMs);
  }
  throw new Error("CPX-Finance did not reach the expected read-only state before the deadline.", {
    ...(lastError === undefined ? {} : { cause: lastError }),
  });
}

export async function ensureDevHome(call, tabId, menuStructure) {
  const setupMeter = {
    call: async (targetCall, operation, input) => targetCall(operation, input),
    protocolDurationMs: 0,
  };
  let navigation = { alreadyHome: true };
  if (await isCpxReady(call, tabId)) {
    navigation = await navigateDevHome(call, tabId);
    if (navigation.destinationReady === false) {
      throw new Error("LegacySite home destination frame is not ready.");
    }
    await waitForDevHome(call, tabId);
  }
  const structure = menuStructure ?? await resolveCpxMenuStructure(call, tabId);
  await ensureFinanceMenuCollapsed(setupMeter, call, tabId, structure);
  return navigation;
}

async function navigateDevHome(call, tabId) {
  return call("navigatePath", {
    tabId,
    path: [HOME_LABEL],
    sourceFramePath: ["Menu"],
    targetFramePath: CONTENT_FRAME,
    segments: [{
      framePath: ["Menu"],
      path: [HOME_LABEL],
      rootSelector: HOME_ROOT_SELECTOR,
      targetFramePath: CONTENT_FRAME,
    }],
    timeoutMs: 30_000,
  });
}

async function ensureFinanceMenuCollapsed(meter, call, tabId, menuStructure) {
  const indexed = await call("domIndex", {
    tabId,
    framePath: ["Menu"],
    rootSelector: menuStructure.financeExpandedRootSelector,
    query: "Financeiro",
    offset: 0,
    limit: 10,
    visibleOnly: true,
  });
  const expandedToggle = indexed.items?.find((item) =>
    item.visible && normalize(item.text) === normalize("Financeiro")
  );
  if (!expandedToggle) return { alreadyCollapsed: true };
  return confirmedFrameSequence(meter, call, {
    tabId,
    steps: [{
      action: "click",
      framePath: ["Menu"],
      locator: { ref: expandedToggle.ref },
    }],
  });
}

export async function waitForDevHome(call, tabId, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const pollMs = options.pollMs ?? 100;
  let lastTransientError;
  while (Date.now() < deadline) {
    try {
      if (!(await isCpxReady(call, tabId))) return { ready: true };
    } catch (error) {
      if (error?.code !== "INTERNAL_ERROR") throw error;
      lastTransientError = error;
    }
    await delay(pollMs);
  }
  throw new Error("LegacySite home reset did not leave CPX-Finance before the deadline.", {
    ...(lastTransientError === undefined ? {} : { cause: lastTransientError }),
  });
}

async function isCpxReady(call, tabId) {
  try {
    const page = await readCpxState(call, tabId);
    return page.header && page.filters;
  } catch (error) {
    if (isExpectedCpxAbsence(error)) return false;
    throw error;
  }
}

export function isExpectedCpxAbsence(error) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  return [
    "FRAME_NOT_FOUND",
    "LOCATOR_NOT_FOUND",
    "LOCATOR_LOW_CONFIDENCE",
    "STATE_NOT_REACHED",
  ].includes(code);
}

function ancestorIdSelector(item, prefix) {
  const marker = `div #${prefix}`;
  for (const ancestor of item?.ancestors ?? []) {
    const value = String(ancestor);
    if (!value.startsWith(marker)) continue;
    const id = value.slice("div #".length);
    const suffix = id.slice(prefix.length);
    if (/^\d+$/u.test(suffix)) return `#${id}`;
  }
  return undefined;
}

function selectorOccurrenceIndex(items, target) {
  if (!target || typeof target.selector !== "string") return undefined;
  let occurrence = 0;
  for (const item of items) {
    if (item?.selector !== target.selector) continue;
    if (item === target) return occurrence;
    occurrence += 1;
  }
  return undefined;
}

export function deriveCpxMenuStructure(financeIndexed, cpxIndexed) {
  const financeItems = (financeIndexed?.items ?? []).filter((item) =>
    normalize(item?.text) === normalize("Financeiro")
  );
  const collapsed = financeItems.find((item) => ancestorIdSelector(item, "Plus"));
  const expanded = financeItems.find((item) => ancestorIdSelector(item, "Minus"));
  const cpxItems = (cpxIndexed?.items ?? []).filter((item) =>
    normalize(item?.text) === normalize("CPX-Finance")
  );
  const cpxOpened = cpxItems.find((item) => ancestorIdSelector(item, "DataOpenned"));
  const financeCollapsedRootSelector = ancestorIdSelector(collapsed, "Plus");
  const financeExpandedRootSelector = ancestorIdSelector(expanded, "Minus");
  const cpxOpenedRootSelector = ancestorIdSelector(cpxOpened, "DataOpenned");
  const financeClickSelector = typeof collapsed?.selector === "string"
    ? collapsed.selector
    : undefined;
  const financeClickIndex = selectorOccurrenceIndex(financeItems, collapsed);
  const cpxClickSelector = typeof cpxOpened?.selector === "string"
    ? cpxOpened.selector
    : undefined;
  const cpxClickIndex = selectorOccurrenceIndex(cpxItems, cpxOpened);
  const cpxVisibleLinkSelector = cpxClickSelector;
  if (
    !financeCollapsedRootSelector ||
    !financeExpandedRootSelector ||
    !cpxOpenedRootSelector ||
    !financeClickSelector ||
    financeClickIndex === undefined ||
    !cpxClickSelector ||
    cpxClickIndex === undefined ||
    !cpxVisibleLinkSelector
  ) {
    throw new Error("Authenticated Dev menu structure could not be resolved safely.");
  }
  return {
    financeCollapsedRootSelector,
    financeExpandedRootSelector,
    financeClickSelector,
    financeClickIndex,
    cpxClickSelector,
    cpxClickIndex,
    cpxVisibleRootSelector: cpxOpenedRootSelector + " font",
    cpxVisibleLinkSelector,
  };
}

async function resolveCpxMenuStructure(call, tabId) {
  const [finance, cpx] = await Promise.all([
    call("domIndex", {
      tabId,
      framePath: ["Menu"],
      query: "Financeiro",
      offset: 0,
      limit: 50,
      visibleOnly: false,
    }),
    call("domIndex", {
      tabId,
      framePath: ["Menu"],
      query: "CPX-Finance",
      offset: 0,
      limit: 20,
      visibleOnly: false,
    }),
  ]);
  return deriveCpxMenuStructure(finance, cpx);
}

async function readCpxState(call, tabId) {
  const primary = await call("frameSequence", {
    tabId,
    steps: [
      {
        action: "extract",
        framePath: CONTENT_FRAME,
        locator: { selector: ".finc-fila-head" },
        format: "text",
      },
      ...["IN2", "IN3", "IN4", "IN5"].map((id) => ({
        action: "assert",
        framePath: CONTENT_FRAME,
        locator: { id },
        condition: "exists",
      })),
    ],
  });
  const headerText = String(primary.steps[0]?.value ?? "");
  let resultsArea = false;
  let rowCount = 0;
  try {
    const results = await call("frameSequence", {
      tabId,
      steps: [{
        action: "extract",
        framePath: CONTENT_FRAME,
        locator: { selector: ".finc-fila-load-count" },
        format: "text",
      }],
    });
    const countText = String(results.steps[0]?.value ?? "");
    resultsArea = results.steps[0]?.completed === true;
    rowCount = parseLoadedCount(countText);
  } catch (error) {
    if (!isExpectedCpxAbsence(error)) throw error;
  }
  return {
    header: normalize(headerText).includes("cpx-finance"),
    filters: primary.steps.slice(1, 5).every((step) => step?.completed === true),
    resultsArea,
    rowCount,
  };
}

function assertCpxPreflight(page) {
  if (!page.header || !page.filters) {
    throw new Error("Dev preflight could not validate the CPX-Finance header and read-only filters.");
  }
}

function assertExpectedFrames(profile) {
  const names = flattenFrames(profile.frames ?? []).map((frame) => frame.name);
  if (!names.includes("Menu") || !names.includes("MenuContent")) {
    throw new Error("Dev preflight did not find the expected LegacySite Menu and MenuContent frames.");
  }
}

function flattenFrames(frames) {
  return frames.flatMap((frame) => [frame, ...flattenFrames(frame.children ?? [])]);
}

export async function waitForManualDevAuthSignal(signalPath, options = {}) {
  const resolved = path.resolve(signalPath);
  const timeoutMs = options.timeoutMs ?? 2 * 60 * 60_000;
  const pollMs = options.pollMs ?? 250;
  if (await stat(resolved).catch(() => undefined)) {
    throw new Error(`Manual Dev auth signal already exists and may be stale: ${resolved}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await stat(resolved).catch(() => undefined)) return resolved;
    await delay(pollMs);
  }
  throw new Error("Manual Dev authentication timed out before the ready signal.");
}

export function isDevMenuAuthenticated(indexed) {
  return Array.isArray(indexed?.items) && indexed.items.some((item) =>
    item?.visible === true &&
    String(item?.text ?? "").trim().toLocaleLowerCase("pt-BR") === "financeiro",
  );
}

export function isDevCpxAvailable(indexed) {
  return Array.isArray(indexed?.items) && indexed.items.some((item) =>
    String(item?.text ?? "").trim().toLocaleLowerCase("pt-BR") === "cpx-finance",
  );
}

async function waitForManualDevAuthentication(options) {
  const [previousTabId, candidateTabId] = await Promise.all([
    openDevTab(options.previousCall, options.url, "previous-manual-auth"),
    openDevTab(options.candidateCall, options.url, "candidate-manual-auth"),
  ]);
  process.stdout.write(`${JSON.stringify({
    event: "dev-manual-auth-required",
    engines: ["previous", "candidate"],
    instruction: "Authenticate both visible Dev browser windows, then create the configured ready signal.",
  })}\n`);
  await waitForManualDevAuthSignal(options.signalPath);
  const [previousMenuStructure, candidateMenuStructure] = await Promise.all([
    waitForDevWorkerAuthenticated(options.previousCall, previousTabId, "previous"),
    waitForDevWorkerAuthenticated(options.candidateCall, candidateTabId, "candidate"),
  ]);
  return {
    mode: "manual-signal-gated",
    verifiedEngines: ["previous", "candidate"],
    tabIds: {
      previous: previousTabId,
      candidate: candidateTabId,
    },
    menuStructures: {
      previous: previousMenuStructure,
      candidate: candidateMenuStructure,
    },
  };
}

export async function waitForDevWorkerAuthenticated(call, tabId, engine, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const pollMs = options.pollMs ?? 250;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const [finance, cpx] = await Promise.all([
        call("domIndex", {
          tabId,
          framePath: ["Menu"],
          query: "Financeiro",
          offset: 0,
          limit: 20,
          visibleOnly: false,
        }),
        call("domIndex", {
          tabId,
          framePath: ["Menu"],
          query: "CPX-Finance",
          offset: 0,
          limit: 20,
          visibleOnly: false,
        }),
      ]);
      if (isDevMenuAuthenticated(finance) && isDevCpxAvailable(cpx)) {
        return deriveCpxMenuStructure(finance, cpx);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(pollMs);
  }
  throw new Error(`Manual Dev authentication or CPX access was not ready for ${engine}.`, {
    ...(lastError === undefined ? {} : { cause: lastError }),
  });
}

export async function openDevTab(call, url, purpose) {
  const input = {
    url,
    purpose: `dev-flow-benchmark-${purpose}`,
    reusable: false,
    protected: false,
    sticky: false,
  };
  let opened;
  try {
    opened = await call("open", input);
  } catch (error) {
    if (error?.code !== "INTERNAL_ERROR") throw error;
    await delay(250);
    const listed = await call("tabs", {});
    const expectedUrl = new URL(url).href;
    const recovered = (listed?.tabs ?? [])
      .filter((tab) => {
        try {
          return typeof tab?.tabId === "string" && new URL(tab.url).href === expectedUrl;
        } catch {
          return false;
        }
      })
      .sort((left, right) => String(right.lastUsedAt ?? "").localeCompare(String(left.lastUsedAt ?? "")))[0];
    opened = recovered ? { tab: recovered } : await call("open", input);
  }
  const tabId = opened?.tab?.tabId;
  if (typeof tabId !== "string") throw new Error("Dev Browser Worker returned no benchmark tabId.");
  assertDevUrl(opened.tab.url, "open");
  return tabId;
}

function assertDevUrl(value, phase) {
  const host = new URL(value).hostname.toLocaleLowerCase("en-US");
  if (!host.includes("dev")) {
    throw new Error(`Dev authentication ${phase} navigated outside the allowed Dev host.`);
  }
}

async function extractText(call, tabId, selector) {
  const result = await call("frameSequence", {
    tabId,
    steps: [{
      action: "extract",
      framePath: CONTENT_FRAME,
      locator: { selector },
      format: "text",
    }],
  });
  return String(result.steps[0]?.value ?? "");
}

export async function createDevVsCodeAdapter({ config, pageId, runtimePath }) {
  const resolvedRuntimePath = path.resolve(
    runtimePath ?? path.join(os.homedir(), ".codex", "vscode-browser-bridge", "runtime.json"),
  );
  const runtime = JSON.parse(await readFile(resolvedRuntimePath, "utf8"));
  if (
    runtime?.host !== "127.0.0.1" ||
    !Number.isInteger(runtime?.port) ||
    !/^[a-f0-9]{64}$/u.test(runtime?.token ?? "")
  ) {
    throw new Error("VS Code browser bridge runtime configuration is invalid.");
  }
  const client = new McpBenchmarkClient({
    name: "vscode-dev-flow-benchmark",
    url: `http://${runtime.host}:${runtime.port}/mcp`,
    token: runtime.token,
    timeoutMs: 35_000,
  });
  const pagesResult = await client.callTool("list_browser_pages", {});
  if (pagesResult?.isError) throw new Error(`VS Code Dev page discovery failed: ${toolText(pagesResult)}`);
  const pages = JSON.parse(toolText(pagesResult)).pages ?? [];
  const selected = pages.find((page) => page.pageId === pageId);
  if (!selected) throw new Error(`VS Code Dev benchmark page is unavailable: ${pageId}.`);
  return {
    async preflight() {
      await prepareVsCodeCpx(client, pageId, config.url);
      const checked = await callVsCodeCode(client, pageId, devReadStateCode(), 30_000);
      const state = parseCodeJson(checked);
      assertCpxPreflight(state);
      return true;
    },
    async run(flowId, context) {
      if (flowId === "cpx-finance-open") {
        await prepareVsCodeHome(client, pageId, config.url);
      } else {
        await prepareVsCodeCpx(client, pageId, config.url);
        if (flowId === "cpx-finance-grid") {
          const setup = await callVsCodeCode(client, pageId, devRefreshBatchCode(config), 45_000);
          const setupResult = parseCodeJson(setup);
          if (!setupResult.accountPreserved || Number(setupResult.rowCount) > config.rowLimit) {
            throw new Error("VS Code Dev grid setup did not preserve the safe filter boundary.");
          }
        }
      }
      const startedAt = performance.now();
      const result = context.pathName === "individual"
        ? await runVsCodeDevIndividual(client, pageId, flowId, config)
        : await runVsCodeDevBatch(client, pageId, flowId, config);
      const durationMs = round(performance.now() - startedAt);
      const observation = result.observation;
      return {
        phase: context.phase,
        success: validateFlowPostcondition(flowId, observation),
        postcondition: validateFlowPostcondition(flowId, observation),
        durationMs,
        responseBytes: result.responseBytes,
        toolCalls: result.toolCalls,
        observation,
        internalTiming: {
          strategy: context.pathName === "individual"
            ? "vscode-native-individual-round-trips"
            : "vscode-run-playwright-static-batch",
        },
      };
    },
    async close() {
      await Promise.race([
        client.close(),
        delay(5_000),
      ]).catch(() => undefined);
    },
  };
}

async function runVsCodeDevIndividual(client, pageId, flowId, config) {
  const calls = [];
  if (flowId === "cpx-finance-open") {
    calls.push(await callVsCodeCode(client, pageId, devOpenFinanceCode(), 20_000));
    calls.push(await callVsCodeCode(client, pageId, devOpenCpxCode(), 45_000));
    const state = parseCodeJson(calls.at(-1));
    return devVsCodeResult(calls, {
      environment: "dev",
      header: state.header,
      filters: state.filters,
      resultsArea: state.resultsArea,
    });
  }
  if (flowId === "cpx-finance-refresh") {
    const dates = safeDateWindow(config.windowDays);
    for (const [selector, value] of [
      ["#IN2", dates.startDate],
      ["#IN3", dates.endDate],
      ["#IN5", String(config.rowLimit)],
    ]) {
      assertDevOperationAllowed({ selector, value });
      calls.push(await callVsCodeCode(client, pageId, devFillCode(selector, value), 15_000));
    }
    calls.push(await callVsCodeCode(client, pageId, devRefreshCode(), 45_000));
    const refreshed = parseCodeJson(calls.at(-1));
    return devVsCodeResult(calls, {
      environment: "dev",
      windowDays: config.windowDays,
      rowCount: refreshed.rowCount,
      accountPreserved: refreshed.accountPreserved,
    });
  }
  if (flowId === "cpx-finance-navigation") {
    const panels = [];
    for (const panel of ["ConferÃªncias", "PendÃªncias", "HistÃ³rico"]) {
      assertDevOperationAllowed(panel);
      calls.push(await callVsCodeCode(client, pageId, devPanelCode(panel), 30_000));
      panels.push(parseCodeJson(calls.at(-1)).panel);
    }
    return devVsCodeResult(calls, { panels });
  }
  if (flowId === "cpx-finance-grid") {
    calls.push(await callVsCodeCode(client, pageId, devGridCode(config.rowLimit), 30_000));
    return devVsCodeResult(calls, parseCodeJson(calls[0]));
  }
  throw new Error(`Unsupported VS Code Dev flow: ${flowId}.`);
}

async function runVsCodeDevBatch(client, pageId, flowId, config) {
  let code;
  switch (flowId) {
    case "cpx-finance-open":
      code = devOpenCpxBatchCode();
      break;
    case "cpx-finance-refresh":
      code = devRefreshBatchCode(config);
      break;
    case "cpx-finance-navigation":
      code = `${devContextCode()}
const panels = [];
for (const panel of ['ConferÃªncias', 'PendÃªncias', 'HistÃ³rico']) {
  await content().getByRole('button', { name: new RegExp('^' + panel) }).evaluate((element) => element.click());
  await content().locator('.finc-fila-view-tab.is-active', { hasText: panel }).waitFor({ state: 'visible', timeout: 30000 });
  panels.push(panel);
}
return JSON.stringify({ panels });`;
      break;
    case "cpx-finance-grid":
      code = devGridCode(config.rowLimit);
      break;
    default:
      throw new Error(`Unsupported VS Code Dev flow: ${flowId}.`);
  }
  const result = await callVsCodeCode(client, pageId, code, 45_000);
  return devVsCodeResult([result], parseCodeJson(result));
}

async function prepareVsCodeCpx(client, pageId, url) {
  const expectedOrigin = new URL(url).origin.toLocaleLowerCase("en-US");
  const result = await callVsCodeCode(client, pageId, `${devLegacySiteContextCode(expectedOrigin)}
let readyContent = content();
let destination = readyContent.locator('.finc-fila-head');
if (await destination.count() === 0) {
  const finance = await firstVisibleExact(menu, 'Financeiro');
  if (!finance) throw new Error('VS Code LegacySite Dev page is not authenticated');
  let cpx = await firstVisibleExact(menu, 'CPX-Finance');
  if (!cpx) {
    await finance.evaluate((element) => element.click());
    const cpxDeadline = Date.now() + 15000;
    while (Date.now() < cpxDeadline) {
      cpx = await firstVisibleExact(menu, 'CPX-Finance');
      if (cpx) break;
      await page.waitForTimeout(50);
    }
  }
  if (!cpx) throw new Error('VS Code CPX-Finance menu item did not become visible');
  await cpx.evaluate((element) => element.click());
  const destinationDeadline = Date.now() + 30000;
  while (Date.now() < destinationDeadline) {
    readyContent = content();
    if (readyContent) {
      destination = readyContent.locator('.finc-fila-head');
      if (await destination.count() === 1 && await destination.isVisible()) break;
    }
    await page.waitForTimeout(50);
  }
}
await destination.waitFor({ state: 'visible', timeout: 30000 });
const active = readyContent.locator('.finc-fila-view-tab.is-active');
const activeText = await active.innerText();
if (!activeText.toLocaleLowerCase('pt-BR').includes('conferÃªncias')) {
  const conference = readyContent.getByRole('button', { name: /^ConferÃªncias/ });
  if (await conference.count() !== 1) throw new Error('VS Code ConferÃªncias panel is unavailable');
  await conference.evaluate((element) => element.click());
  await readyContent.locator('.finc-fila-view-tab.is-active', { hasText: 'ConferÃªncias' }).waitFor({ state: 'visible', timeout: 30000 });
}
return page.url();`, 45_000);
  if (!toolText(result.result).toLocaleLowerCase("en-US").includes("dev")) {
    throw new Error("VS Code Dev preflight left the expected Dev environment.");
  }
}

async function prepareVsCodeHome(client, pageId, url) {
  const expectedOrigin = new URL(url).origin.toLocaleLowerCase("en-US");
  const result = await callVsCodeCode(client, pageId, `${devLegacySiteContextCode(expectedOrigin)}
const finance = await firstVisibleExact(menu, 'Financeiro');
if (!finance) throw new Error('VS Code LegacySite Dev page is not authenticated');
let currentContent = content();
if (currentContent && await currentContent.locator('.finc-fila-head').count() > 0) {
  const home = await firstVisibleExact(menu, 'Novidades (Home)');
  if (!home) throw new Error('VS Code LegacySite Home item is unavailable');
  await home.evaluate((element) => element.click());
  const homeDeadline = Date.now() + 30000;
  while (Date.now() < homeDeadline) {
    currentContent = content();
    if (currentContent && await currentContent.locator('.finc-fila-head').count() === 0) break;
    await page.waitForTimeout(50);
  }
  if (currentContent && await currentContent.locator('.finc-fila-head').count() > 0) {
    throw new Error('VS Code LegacySite Home reset did not complete');
  }
}
return page.url();`, 45_000);
  if (!toolText(result.result).toLocaleLowerCase("en-US").includes("dev")) {
    throw new Error("VS Code Dev Home preparation left the expected environment.");
  }
}

function devLegacySiteContextCode(expectedOrigin) {
  return `const currentUrl = page.url().toLocaleLowerCase('en-US');
const expectedOrigin = ${JSON.stringify(expectedOrigin)};
if (currentUrl !== expectedOrigin && !currentUrl.startsWith(expectedOrigin + '/')) {
  throw new Error('VS Code Dev page is outside the expected host');
}
const frameDeadline = Date.now() + 30000;
let menu;
while (Date.now() < frameDeadline) {
  menu = page.frames().find((candidate) => candidate.name() === 'Menu');
  if (menu && page.frames().some((candidate) => candidate.name() === 'MenuContent')) break;
  await page.waitForTimeout(50);
}
const content = () => page.frames().find((candidate) => candidate.name() === 'MenuContent');
if (!menu || !content()) throw new Error('Missing LegacySite Menu or MenuContent frame');
const firstVisibleExact = async (frame, label) => {
  const matches = frame.getByText(label, { exact: true });
  const count = await matches.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = matches.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  return undefined;
};`;
}

function devOpenFinanceCode() {
  return `${devLegacySiteContextCode('https://dev-private.example.test')}
let cpx = await firstVisibleExact(menu, 'CPX-Finance');
if (!cpx) {
  const finance = await firstVisibleExact(menu, 'Financeiro');
  if (!finance) throw new Error('VS Code LegacySite Dev page is not authenticated');
  await finance.evaluate((element) => element.click());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    cpx = await firstVisibleExact(menu, 'CPX-Finance');
    if (cpx) break;
    await page.waitForTimeout(50);
  }
}
if (!cpx) throw new Error('VS Code CPX-Finance menu item did not become visible');
return 'finance-ready';`;
}

function devOpenCpxCode() {
  return `${devLegacySiteContextCode('https://dev-private.example.test')}
const cpx = await firstVisibleExact(menu, 'CPX-Finance');
if (!cpx) throw new Error('VS Code CPX-Finance menu item is not visible');
await cpx.evaluate((element) => element.click());
const deadline = Date.now() + 30000;
let ready;
let filters = [];
let destinationReady = false;
while (Date.now() < deadline) {
  ready = content();
  if (ready) {
    const headerCount = await ready.locator('.finc-fila-head').count();
    filters = await Promise.all(['#IN2','#IN3','#IN4','#IN5'].map((selector) => ready.locator(selector).count()));
    if (headerCount === 1 && filters.every(Boolean)) {
      destinationReady = true;
      break;
    }
  }
  await page.waitForTimeout(50);
}
if (!ready || !destinationReady) throw new Error('VS Code CPX-Finance destination is unavailable');
const headerText = await ready.locator('.finc-fila-head').innerText();
const resultsArea = await ready.locator('.finc-fila-load-count').count();
return JSON.stringify({ environment: 'dev', header: /CPX-Finance/i.test(headerText), filters: filters.every(Boolean), resultsArea: Boolean(resultsArea) });`;
}

function devOpenCpxBatchCode() {
  return `${devLegacySiteContextCode('https://dev-private.example.test')}
let cpx = await firstVisibleExact(menu, 'CPX-Finance');
if (!cpx) {
  const finance = await firstVisibleExact(menu, 'Financeiro');
  if (!finance) throw new Error('VS Code LegacySite Dev page is not authenticated');
  await finance.evaluate((element) => element.click());
  const menuDeadline = Date.now() + 15000;
  while (Date.now() < menuDeadline) {
    cpx = await firstVisibleExact(menu, 'CPX-Finance');
    if (cpx) break;
    await page.waitForTimeout(50);
  }
}
if (!cpx) throw new Error('VS Code CPX-Finance menu item did not become visible');
await cpx.evaluate((element) => element.click());
const destinationDeadline = Date.now() + 30000;
let ready;
let filters = [];
let destinationReady = false;
while (Date.now() < destinationDeadline) {
  ready = content();
  if (ready) {
    const headerCount = await ready.locator('.finc-fila-head').count();
    filters = await Promise.all(['#IN2','#IN3','#IN4','#IN5'].map((selector) => ready.locator(selector).count()));
    if (headerCount === 1 && filters.every(Boolean)) {
      destinationReady = true;
      break;
    }
  }
  await page.waitForTimeout(50);
}
if (!ready || !destinationReady) throw new Error('VS Code CPX-Finance destination is unavailable');
const headerText = await ready.locator('.finc-fila-head').innerText();
const resultsArea = await ready.locator('.finc-fila-load-count').count();
return JSON.stringify({ environment: 'dev', header: /CPX-Finance/i.test(headerText), filters: filters.every(Boolean), resultsArea: Boolean(resultsArea) });`;
}

function devContextCode() {
  return "const content = () => page.frames().find((candidate) => candidate.name() === 'MenuContent');";
}

function devReadStateCode() {
  return `${devContextCode()}
const headerText = await content().locator('.finc-fila-head').innerText();
const filters = await Promise.all(['#IN2','#IN3','#IN4','#IN5'].map((selector) => content().locator(selector).count()));
const resultsArea = await content().locator('.finc-fila-load-count').count();
const countText = resultsArea ? await content().locator('.finc-fila-load-count').innerText() : '';
return JSON.stringify({ header: /CPX-Finance/i.test(headerText), filters: filters.every(Boolean), resultsArea: Boolean(resultsArea), rowCount: Number((/([0-9]+)\\s+lan/i.exec(countText)||[])[1]||0) });`;
}

function devFillCode(selector, value) {
  return `${devContextCode()} await content().locator(${JSON.stringify(selector)}).fill(${JSON.stringify(value)}); return 'filled';`;
}

function devRefreshCode() {
  return `${devContextCode()}
const accountBefore = await content().locator('#IN4').inputValue();
const responsePromise = page.waitForResponse(
  (response) => response.request().method() === 'POST' && response.url().includes('/LegacySite.asp'),
  { timeout: 30000 },
);
await content().locator('.finc-fila-filter-refresh').evaluate((element) => element.click());
const response = await responsePromise;
if (!response.ok()) throw new Error('VS Code Dev refresh POST failed');
const frameDeadline = Date.now() + 30000;
let ready;
while (Date.now() < frameDeadline) {
  ready = content();
  if (ready && await ready.locator('.finc-fila-load-count').count() === 1) break;
  await page.waitForTimeout(50);
}
if (!ready) throw new Error('VS Code Dev refresh result is unavailable');
const countText = await ready.locator('.finc-fila-load-count').innerText();
const accountAfter = await ready.locator('#IN4').inputValue();
return JSON.stringify({ rowCount: Number((/([0-9]+)\\s+lan/i.exec(countText)||[])[1]||0), accountPreserved: accountBefore === accountAfter });`;
}

function devRefreshBatchCode(config) {
  const dates = safeDateWindow(config.windowDays);
  return `${devContextCode()}
const accountBefore = await content().locator('#IN4').inputValue();
await content().locator('#IN2').fill(${JSON.stringify(dates.startDate)});
await content().locator('#IN3').fill(${JSON.stringify(dates.endDate)});
await content().locator('#IN5').fill(${JSON.stringify(String(config.rowLimit))});
const responsePromise = page.waitForResponse(
  (response) => response.request().method() === 'POST' && response.url().includes('/LegacySite.asp'),
  { timeout: 30000 },
);
await content().locator('.finc-fila-filter-refresh').evaluate((element) => element.click());
const response = await responsePromise;
if (!response.ok()) throw new Error('VS Code Dev refresh POST failed');
const frameDeadline = Date.now() + 30000;
let ready;
while (Date.now() < frameDeadline) {
  ready = content();
  if (ready && await ready.locator('.finc-fila-load-count').count() === 1) break;
  await page.waitForTimeout(50);
}
if (!ready) throw new Error('VS Code Dev refresh result is unavailable');
const countText = await ready.locator('.finc-fila-load-count').innerText();
const accountAfter = await ready.locator('#IN4').inputValue();
return JSON.stringify({ environment: 'dev', windowDays: ${Number(config.windowDays)}, rowCount: Number((/([0-9]+)\\s+lan/i.exec(countText)||[])[1]||0), accountPreserved: accountBefore === accountAfter });`;
}

function devPanelCode(panel) {
  return `${devContextCode()}
await content().getByRole('button', { name: new RegExp('^' + ${JSON.stringify(panel)}) }).evaluate((element) => element.click());
await content().locator('.finc-fila-view-tab.is-active', { hasText: ${JSON.stringify(panel)} }).waitFor({ state: 'visible', timeout: 30000 });
return JSON.stringify({ panel: ${JSON.stringify(panel)} });`;
}

function devGridCode(limit) {
  return `${devContextCode()}
const countText = await content().locator('.finc-fila-load-count').innerText();
const rowCount = Math.min(Number((/([0-9]+)\\s+lan/i.exec(countText)||[])[1]||0), ${Number(limit)});
if (!rowCount) return JSON.stringify({ empty: true, rowCount: 0 });
const tableText = await content().locator('.finc-fila-table').innerText();
return JSON.stringify({ empty: false, rowCount, tableText });`;
}

function devVsCodeResult(calls, observation) {
  if (observation.tableText !== undefined && observation.rowCount !== undefined && !observation.sha256) {
    const signature = sanitizedGridSignature(
      observation.tableText ?? "",
      observation.rowCount,
    );
    observation = {
      empty: false,
      rowCount: observation.rowCount,
      sha256: signature.sha256,
    };
  }
  return {
    toolCalls: calls.reduce((sum, call) => sum + call.callCount, 0),
    responseBytes: calls.reduce((sum, call) => sum + call.bytes, 0),
    observation,
  };
}

async function callVsCodeCode(client, pageId, code, timeoutMs) {
  return callVsCodeMcp(client, "run_playwright_code", { pageId, code, timeoutMs });
}

function parseCodeJson(result) {
  const parsed = JSON.parse(extractToolResult(result.result));
  return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
}

function summarizeDevFlow(raw, warmups) {
  return {
    previous: {
      optimized: summarizeFlowSamples(raw.previous.optimized, warmups),
      samples: raw.previous.optimized,
    },
    candidate: {
      optimized: summarizeFlowSamples(raw.candidate.optimized, warmups),
      gateway: summarizeFlowSamples(raw.candidate.gateway, warmups),
      samples: {
        optimized: raw.candidate.optimized,
        gateway: raw.candidate.gateway,
      },
    },
    vscode: {
      individual: summarizeFlowSamples(raw.vscode.individual, warmups),
      batch: summarizeFlowSamples(raw.vscode.batch, warmups),
      samples: {
        individual: raw.vscode.individual,
        batch: raw.vscode.batch,
      },
    },
  };
}

function finalize(flowId, measured, observation, internalTiming) {
  const postcondition = validateFlowPostcondition(flowId, observation);
  return {
    phase: measured.phase,
    success: postcondition,
    postcondition,
    durationMs: measured.durationMs,
    ...(measured.protocolDurationMs === undefined
      ? {}
      : { protocolDurationMs: measured.protocolDurationMs }),
    responseBytes: measured.responseBytes,
    toolCalls: measured.toolCalls,
    observation,
    internalTiming,
  };
}

async function measure(context, run) {
  const meter = {
    toolCalls: 0,
    responseBytes: 0,
    protocolDurationMs: undefined,
    async call(call, operation, input) {
      this.toolCalls += 1;
      const result = await call(operation, input);
      this.responseBytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      return result;
    },
  };
  const startedAt = performance.now();
  const value = await run(meter);
  return {
    phase: context.phase,
    durationMs: round(performance.now() - startedAt),
    ...(meter.protocolDurationMs === undefined
      ? {}
      : { protocolDurationMs: meter.protocolDurationMs }),
    responseBytes: meter.responseBytes,
    toolCalls: meter.toolCalls,
    value,
  };
}

function parseConfirmation(message) {
  const marker = "Confirmation required: ";
  const offset = message.indexOf(marker);
  if (offset < 0) throw new Error("Confirmation payload was not found.");
  const tail = message.slice(offset + marker.length);
  const end = tail.lastIndexOf("}");
  const parsed = JSON.parse(tail.slice(0, end + 1));
  if (typeof parsed?.confirmationId !== "string") {
    throw new Error("Confirmation payload contains no confirmationId.");
  }
  return parsed;
}

function safeDateWindow(windowDays) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (windowDays - 1));
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

function formatDate(value) {
  return [
    String(value.getDate()).padStart(2, "0"),
    String(value.getMonth() + 1).padStart(2, "0"),
    value.getFullYear(),
  ].join("/");
}

function parseLoadedCount(value) {
  return Number(/([0-9]+)\s+lan/iu.exec(value)?.[1] ?? 0);
}

async function assertProfileDirectories(profiles) {
  for (const [engine, profilePath] of Object.entries(profiles)) {
    const details = await stat(profilePath).catch(() => undefined);
    if (!details?.isDirectory()) {
      throw new Error(`Dedicated Dev profile does not exist for ${engine}: ${profilePath}.`);
    }
  }
}

async function readDevHistory(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== "flows.json") continue;
    const parentPath = entry.parentPath ?? entry.path;
    if (!parentPath) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(parentPath, entry.name), "utf8"));
      if (parsed.dev?.flows) {
        reports.push({
          runId: parsed.runId,
          suite: "dev",
          source: parsed.source,
          flows: parsed.dev.flows,
          safety: parsed.dev.safety,
          capturedAt: parsed.capturedAt,
        });
      }
    } catch {
      // Invalid or incomplete history artifacts are not comparable runs.
    }
  }
  return reports.sort((left, right) =>
    String(left.capturedAt).localeCompare(String(right.capturedAt))
  );
}

function pathSignature(value) {
  return createHash("sha256")
    .update(value.toLocaleLowerCase("en-US"))
    .digest("hex");
}

function normalize(value) {
  return String(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
}

function toolText(result) {
  return (result?.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
