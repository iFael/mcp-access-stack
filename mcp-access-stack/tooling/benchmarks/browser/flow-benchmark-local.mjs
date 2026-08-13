import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpBenchmarkClient } from "../mcp/mcp-client.mjs";
import {
  BrowserBenchmarkOperationError,
} from "./browser-benchmark-runtime.mjs";
import {
  LOCAL_FLOW_IDS,
  validateFlowPostcondition,
} from "./flow-benchmark-core.mjs";

const MENU_PATH = ["Financeiro", "CPX-Finance", "Histórico"];
const LARGE_MENU_PATH = ["Financeiro", "CPX-Finance", "Histórico", "Conferências"];

export function createWorkerFlowAdapter({
  name,
  call,
  fixture,
  route = "direct",
  supportsNavigationCheckpoint = true,
}) {
  return {
    name,
    route,
    async run(flowId, context) {
      if (!LOCAL_FLOW_IDS.includes(flowId)) throw new Error(`Unsupported local flow: ${flowId}.`);
      const nonce = `${name}-${route}-${flowId}-${context.scheduleIndex}-${context.pathName}`;
      switch (flowId) {
        case "legacy-menu-cold":
          return runWorkerColdMenu(
            call, fixture, nonce, context, supportsNavigationCheckpoint,
          );
        case "legacy-menu-warm":
          return runWorkerWarmMenu(
            call, fixture, nonce, context, supportsNavigationCheckpoint,
          );
        case "large-menu":
          return runWorkerLargeMenu(
            call, fixture, nonce, context, supportsNavigationCheckpoint,
          );
        case "multi-frame-form":
          return runWorkerForm(call, fixture, nonce, context);
        case "controlled-postback":
          return runWorkerPostback(call, fixture, nonce, context);
      }
    },
  };
}

export async function createVsCodeFlowAdapter(options) {
  const runtimePath = path.resolve(
    options.runtimePath ??
      path.join(os.homedir(), ".codex", "vscode-browser-bridge", "runtime.json"),
  );
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  if (
    runtime?.host !== "127.0.0.1" ||
    !Number.isInteger(runtime?.port) ||
    !/^[a-f0-9]{64}$/u.test(runtime?.token ?? "")
  ) {
    throw new Error("VS Code browser bridge runtime configuration is invalid.");
  }
  const client = new McpBenchmarkClient({
    name: "vscode-flow-benchmark",
    url: `http://${runtime.host}:${runtime.port}/mcp`,
    token: runtime.token,
    timeoutMs: 20_000,
  });
  const tools = await client.listTools();
  for (const name of [
    "list_browser_pages",
    "read_page",
    "click_element",
    "type_in_page",
    "run_playwright_code",
  ]) {
    if (!tools.tools.some((tool) => tool.name === name)) {
      await withTimeout(client.close(), 5_000).catch(() => undefined);
      throw new Error(`VS Code native browser tool is unavailable: ${name}.`);
    }
  }
  const listed = await mcpCall(client, "list_browser_pages", {});
  const pages = parseVsCodePages(listed.result);
  const selectedPage = pages.find((page) => page.pageId === options.pageId);
  if (!selectedPage) {
    await withTimeout(client.close(), 5_000).catch(() => undefined);
    throw new Error(`VS Code shared page is unavailable: ${options.pageId}.`);
  }
  const pageId = selectedPage.pageId;
  const originalUrl = selectedPage.url;
  return {
    name: "vscode",
    route: "native-bridge",
    async run(flowId, context) {
      if (!LOCAL_FLOW_IDS.includes(flowId)) throw new Error(`Unsupported local flow: ${flowId}.`);
      const nonce = `vscode-${flowId}-${context.scheduleIndex}-${context.pathName}`;
      return context.pathName === "batch"
        ? runVsCodeBatch(client, pageId, flowId, options.fixture, nonce, context)
        : runVsCodeIndividual(client, pageId, flowId, options.fixture, nonce, context);
    },
    async close() {
      if (originalUrl && originalUrl !== "about:blank") {
        await withTimeout(mcpCall(client, "run_playwright_code", {
          pageId,
          code: `await page.goto(${JSON.stringify(originalUrl)}, { waitUntil: 'domcontentloaded', timeout: 15000 }); return page.url();`,
          timeoutMs: 15_000,
        }), 20_000).catch(() => undefined);
      }
      await withTimeout(client.close(), 5_000).catch(() => undefined);
    },
  };
}

async function runWorkerColdMenu(
  call, fixture, nonce, context, supportsNavigationCheckpoint,
) {
  const primed = await openWorkerTab(
    call,
    fixture.legacyUrl(nonce, "poison"),
    `${nonce}-prime`,
  );
  try {
    await call("navigatePath", menuInput(primed.tabId, supportsNavigationCheckpoint));
  } finally {
    await closeWorkerTab(call, primed.tabId);
  }
  const opened = await openWorkerTab(
    call,
    fixture.legacyUrl(nonce, "normal"),
    nonce,
  );
  const tabId = opened.tabId;
  try {
    const measured = await measureCalls(context, async (meter) => {
      const result = await navigateWithCheckpoint(
        meter,
        call,
        menuInput(tabId, supportsNavigationCheckpoint),
        {
          action: "extract",
          framePath: ["MenuContent"],
          locator: { selector: "h1" },
          format: "text",
        },
      );
      return { result };
    });
    const observation = {
      destinationReady: measured.value.result.destinationReady,
      heading: measured.value.result.checkpoint?.step?.value,
      cache: measured.value.result.cache,
    };
    return finalizeMeasuredSample(
      measured,
      observation,
      measured.value.result.telemetry,
    );
  } finally {
    await closeWorkerTab(call, tabId);
  }
}

async function runWorkerWarmMenu(
  call, fixture, nonce, context, supportsNavigationCheckpoint,
) {
  const primed = await openWorkerTab(
    call,
    fixture.legacyUrl(nonce),
    `${nonce}-prime`,
  );
  try {
    await call("navigatePath", menuInput(primed.tabId, supportsNavigationCheckpoint));
  } finally {
    await closeWorkerTab(call, primed.tabId);
  }
  const opened = await openWorkerTab(call, fixture.legacyUrl(nonce), nonce);
  const tabId = opened.tabId;
  try {
    const measured = await measureCalls(context, async (meter) => {
      const result = await navigateWithCheckpoint(
        meter,
        call,
        menuInput(tabId, supportsNavigationCheckpoint),
        {
          action: "extract",
          framePath: ["MenuContent"],
          locator: { selector: "h1" },
          format: "text",
        },
      );
      return { result };
    });
    const observation = {
      destinationReady: measured.value.result.destinationReady,
      heading: measured.value.result.checkpoint?.step?.value,
      cache: measured.value.result.cache,
    };
    return finalizeMeasuredSample(
      measured,
      observation,
      measured.value.result.telemetry,
    );
  } finally {
    await closeWorkerTab(call, tabId);
  }
}

async function runWorkerLargeMenu(
  call, fixture, nonce, context, supportsNavigationCheckpoint,
) {
  const opened = await openWorkerTab(call, fixture.segmentedUrl, nonce);
  const tabId = opened.tabId;
  try {
    const measured = await measureCalls(context, async (meter) => {
      const index = await meter.call(call, "domIndex", {
        tabId,
        framePath: ["Menu"],
        offset: 2_500,
        limit: 10,
      });
      const navigation = await navigateWithCheckpoint(
        meter,
        call,
        largeMenuInput(tabId, supportsNavigationCheckpoint),
        {
          action: "extract",
          framePath: ["MenuContent"],
          locator: { selector: ".tab.is-active" },
          format: "text",
        },
      );
      return { index, navigation };
    });
    const indexedItems = measured.value.index.totalCount ??
      (measured.value.index.items?.length ?? 0);
    const observation = {
      indexedItems,
      heading: measured.value.navigation.checkpoint?.step?.value,
      destinationReady: measured.value.navigation.destinationReady,
    };
    return finalizeMeasuredSample(
      measured,
      observation,
      combineTelemetry([
        measured.value.index.telemetry,
        measured.value.navigation.telemetry,
      ]),
    );
  } finally {
    await closeWorkerTab(call, tabId);
  }
}

async function runWorkerForm(call, fixture, nonce, context) {
  const opened = await openWorkerTab(call, fixture.legacyUrl(nonce), nonce);
  const tabId = opened.tabId;
  try {
    const measured = await measureCalls(context, async (meter) => {
      const result = await meter.call(call, "frameSequence", {
        tabId,
        steps: [
          {
            action: "fill",
            framePath: ["MenuContent"],
            locator: { id: "query" },
            value: "consulta legacy",
          },
          {
            action: "select",
            framePath: ["MenuContent"],
            locator: { id: "category" },
            value: "recent",
          },
          {
            action: "press",
            framePath: ["MenuContent"],
            locator: { id: "query" },
            key: "ArrowRight",
          },
          {
            action: "extract",
            framePath: ["MenuContent"],
            locator: { id: "query" },
            format: "text",
          },
          {
            action: "extract",
            framePath: ["MenuContent"],
            locator: { id: "category" },
            format: "text",
          },
          {
            action: "assert",
            framePath: ["MenuContent"],
            locator: { id: "query" },
            condition: "textEquals",
            expected: "consulta legacy",
          },
        ],
      });
      return { result };
    });
    const observation = {
      query: measured.value.result.steps[3]?.value,
      category: measured.value.result.steps[4]?.value,
      asserted: measured.value.result.steps[5]?.completed === true,
    };
    return finalizeMeasuredSample(measured, observation, measured.value.result.telemetry);
  } finally {
    await closeWorkerTab(call, tabId);
  }
}

async function runWorkerPostback(call, fixture, nonce, context) {
  const opened = await openWorkerTab(call, fixture.legacyUrl(nonce), nonce);
  const tabId = opened.tabId;
  const baseInput = {
    tabId,
    steps: [
      {
        action: "click",
        framePath: ["MenuContent"],
        locator: { id: "confirm-post" },
      },
      {
        action: "waitFor",
        framePath: ["MenuContent"],
        locator: { selector: "#postback-heading" },
        state: "visible",
        timeoutMs: 10_000,
      },
      {
        action: "extract",
        framePath: ["MenuContent"],
        locator: { selector: "#post-count" },
        format: "text",
      },
    ],
  };
  try {
    const protocolStartedAt = performance.now();
    let confirmation;
    let firstResponseBytes = 0;
    let firstFastPathCalls = 0;
    let firstGatewayTiming;
    try {
      await call("frameSequence", baseInput);
      throw new Error("Controlled POST executed without a confirmation challenge.");
    } catch (error) {
      if (!(error instanceof BrowserBenchmarkOperationError)) throw error;
      if (error.code !== "ACTION_REQUIRES_CONFIRMATION") throw error;
      confirmation = parseConfirmation(error.message);
      firstResponseBytes = Buffer.byteLength(error.message, "utf8");
      firstFastPathCalls = error.benchmarkTransport?.route ===
        "legacy-browser-fast-path-v1"
        ? 1
        : 0;
      firstGatewayTiming = error.benchmarkTransport?.gatewayTiming;
    }
    const executionStartedAt = performance.now();
    const measured = await measureCalls(context, async (meter) => {
      const result = await meter.call(call, "frameSequence", {
        ...baseInput,
        steps: baseInput.steps.map((step, index) =>
          index === 0 ? { ...step, confirmationId: confirmation.confirmationId } : step
        ),
      });
      return { result };
    });
    const executionDurationMs = elapsed(executionStartedAt);
    const protocolDurationMs = elapsed(protocolStartedAt);
    const postCount = fixture.getPostCount(nonce);
    const observation = {
      confirmationRequired: true,
      confirmation: { applicable: true, supported: true, challenged: true },
      documentReplaced:
        measured.value.result.steps[1]?.completed === true &&
        measured.value.result.steps[2]?.value === "1",
      postCount,
    };
    return finalizeMeasuredSample(
      {
        ...measured,
        durationMs: protocolDurationMs,
        comparisonDurationMs: executionDurationMs,
        protocolDurationMs,
        executionDurationMs,
        responseBytes: measured.responseBytes + firstResponseBytes,
        toolCalls: measured.toolCalls + 1,
        fastPathCalls: (measured.fastPathCalls ?? 0) + firstFastPathCalls,
        gatewayTimings: [
          ...(firstGatewayTiming ? [firstGatewayTiming] : []),
          ...(measured.gatewayTimings ?? []),
        ],
        comparisonRequestBytes: measured.requestBytes,
        comparisonResponseBytes: measured.responseBytes,
        comparisonToolCalls: measured.toolCalls,
        comparisonTransportMs: measured.transportMs,
        comparisonToolRoundTripMs: measured.toolRoundTripMs,
        comparisonEngineMs: measured.engineMs,
        comparisonFastPathCalls: measured.fastPathCalls ?? 0,
        comparisonGatewayTimings: measured.gatewayTimings ?? [],
      },
      observation,
      measured.value.result.telemetry,
      { confirmationCategory: confirmation.category },
    );
  } finally {
    await closeWorkerTab(call, tabId);
  }
}

async function runVsCodeIndividual(client, pageId, flowId, fixture, nonce, context) {
  const setupUrl = flowId === "large-menu"
    ? fixture.segmentedUrl
    : fixture.legacyUrl(nonce);
  await prepareVsCodePage(client, pageId, setupUrl);
  const measured = await measureCalls(context, async (meter) => {
    switch (flowId) {
      case "legacy-menu-cold":
      case "legacy-menu-warm": {
        await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: frameActionCode("Menu", "#financeiro", "click"),
          timeoutMs: 10_000,
        });
        await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: frameActionCode("Menu", "#cpx-finance", "click"),
          timeoutMs: 10_000,
        });
        const result = await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: `${frameActionCode("Menu", "#historico", "click", false)}
const target = page.frames().find((frame) => frame.name() === 'MenuContent');
await target.waitForURL(/historico\\.html/, { timeout: 10000 });
return await target.locator('h1').innerText();`,
          timeoutMs: 10_000,
        });
        return { heading: extractToolResult(result.result) };
      }
      case "large-menu": {
        const indexed = await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: `const menu = page.frames().find((frame) => frame.name() === 'Menu');
return await menu.locator('a').count();`,
          timeoutMs: 10_000,
        });
        for (const selector of ["#financeiro-segmented", "#cpx-finance-segmented"]) {
          await meter.mcp(client, "run_playwright_code", {
            pageId,
            code: frameActionCode("Menu", selector, "click"),
            timeoutMs: 10_000,
          });
        }
        for (const label of ["Histórico", "Conferências"]) {
          await meter.mcp(client, "run_playwright_code", {
            pageId,
            code: `const frame = page.frames().find((candidate) => candidate.name() === 'MenuContent');
await frame.getByRole('button', { name: ${JSON.stringify(label)}, exact: true }).evaluate((element) => element.click());
await frame.locator('.tab.is-active', { hasText: ${JSON.stringify(label)} }).waitFor({ state: 'visible' });
return ${JSON.stringify(label)};`,
            timeoutMs: 10_000,
          });
        }
        return {
          indexedItems: Number(extractToolResult(indexed.result)),
          heading: "Conferências",
        };
      }
      case "multi-frame-form": {
        await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: frameActionCode("MenuContent", "#query", "fill", true, "consulta legacy"),
          timeoutMs: 10_000,
        });
        await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: `const frame = page.frames().find((candidate) => candidate.name() === 'MenuContent');
await frame.locator('#category').selectOption('recent'); return 'recent';`,
          timeoutMs: 10_000,
        });
        await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: frameActionCode("MenuContent", "#query", "press", true, "ArrowRight"),
          timeoutMs: 10_000,
        });
        const query = await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: `const frame = page.frames().find((candidate) => candidate.name() === 'MenuContent');
return await frame.locator('#query').inputValue();`,
          timeoutMs: 10_000,
        });
        const category = await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: `const frame = page.frames().find((candidate) => candidate.name() === 'MenuContent');
return await frame.locator('#category').inputValue();`,
          timeoutMs: 10_000,
        });
        return {
          query: extractToolResult(query.result),
          category: extractToolResult(category.result),
        };
      }
      case "controlled-postback": {
        const executionStartedAt = performance.now();
        const result = await meter.mcp(client, "run_playwright_code", {
          pageId,
          code: `const frame = page.frames().find((candidate) => candidate.name() === 'MenuContent');
await frame.locator('#confirm-post').evaluate((element) => element.click());
await frame.locator('#postback-heading').waitFor({ state: 'visible', timeout: 10000 });
return await frame.locator('#post-count').innerText();`,
          timeoutMs: 10_000,
        });
        return {
          confirmation: { applicable: false, supported: false, challenged: false },
          postCountText: extractToolResult(result.result),
          executionDurationMs: elapsed(executionStartedAt),
        };
      }
    }
  });
  return finalizeVsCodeSample(flowId, measured, fixture, nonce, context, false);
}

async function runVsCodeBatch(client, pageId, flowId, fixture, nonce, context) {
  const setupUrl = flowId === "large-menu"
    ? fixture.segmentedUrl
    : fixture.legacyUrl(nonce);
  await prepareVsCodePage(client, pageId, setupUrl);
  const measured = await measureCalls(context, async (meter) => {
    const executionStartedAt = performance.now();
    const result = await meter.mcp(client, "run_playwright_code", {
      pageId,
      code: vsCodeBatchCode(flowId),
      timeoutMs: 15_000,
    });
    return {
      toolResult: extractToolResult(result.result),
      executionDurationMs: flowId === "controlled-postback"
        ? elapsed(executionStartedAt)
        : undefined,
    };
  });
  return finalizeVsCodeSample(flowId, measured, fixture, nonce, context, true);
}

function finalizeVsCodeSample(flowId, measured, fixture, nonce, context, batch) {
  let observation;
  if (batch) {
    const value = parseJsonToolResult(measured.value.toolResult);
    observation = value;
  } else {
    switch (flowId) {
      case "legacy-menu-cold":
        observation = {
          destinationReady: true,
          heading: measured.value.heading,
          executionPhase: "first",
          cache: { applicable: false },
        };
        break;
      case "legacy-menu-warm":
        observation = {
          destinationReady: true,
          heading: measured.value.heading,
          executionPhase: "repeat",
          cache: { applicable: false },
        };
        break;
      case "large-menu":
        observation = {
          indexedItems: measured.value.indexedItems,
          heading: measured.value.heading,
          destinationReady: true,
        };
        break;
      case "multi-frame-form":
        observation = {
          query: measured.value.query,
          category: measured.value.category,
          asserted: measured.value.query === "consulta legacy",
        };
        break;
      case "controlled-postback":
        observation = {
          confirmation: measured.value.confirmation,
          documentReplaced: measured.value.postCountText === "1",
          postCount: fixture.getPostCount(nonce),
        };
        break;
    }
  }
  const executionDurationMs = flowId === "controlled-postback"
    ? measured.value.executionDurationMs ?? measured.durationMs
    : undefined;
  return finalizeMeasuredSample({
    ...measured,
    ...(executionDurationMs === undefined
      ? {}
      : {
          comparisonDurationMs: executionDurationMs,
          executionDurationMs,
        }),
  }, observation, {
    strategy: batch ? "vscode-run-playwright-static-batch" : "vscode-native-individual-round-trips",
  }, {
    confirmationCategory: flowId === "controlled-postback" ? "local-readwrite-fixture" : undefined,
  });
}

function vsCodeBatchCode(flowId) {
  const frame = "const menu = page.frames().find((candidate) => candidate.name() === 'Menu');\n" +
    "const content = () => page.frames().find((candidate) => candidate.name() === 'MenuContent');\n";
  switch (flowId) {
    case "legacy-menu-cold":
      return `${frame}
await menu.locator('#financeiro').evaluate((element) => element.click());
await menu.locator('#cpx-finance').evaluate((element) => element.click());
await menu.locator('#historico').evaluate((element) => element.click());
await content().waitForURL(/historico\\.html/, { timeout: 10000 });
return JSON.stringify({ destinationReady: true, heading: await content().locator('h1').innerText(), executionPhase: 'first', cache: { applicable: false } });`;
    case "legacy-menu-warm":
      return `${frame}
await menu.locator('#financeiro').evaluate((element) => element.click());
await menu.locator('#cpx-finance').evaluate((element) => element.click());
await menu.locator('#historico').evaluate((element) => element.click());
await content().waitForURL(/historico\\.html/, { timeout: 10000 });
return JSON.stringify({ destinationReady: true, heading: await content().locator('h1').innerText(), executionPhase: 'repeat', cache: { applicable: false } });`;
    case "large-menu":
      return `${frame}
const indexedItems = await menu.locator('a').count();
await menu.locator('#financeiro-segmented').evaluate((element) => element.click());
await menu.locator('#cpx-finance-segmented').evaluate((element) => element.click());
await content().getByRole('button', { name: 'Histórico', exact: true }).evaluate((element) => element.click());
await content().locator('.tab.is-active', { hasText: 'Histórico' }).waitFor({ state: 'visible' });
await content().getByRole('button', { name: 'Conferências', exact: true }).evaluate((element) => element.click());
await content().locator('.tab.is-active', { hasText: 'Conferências' }).waitFor({ state: 'visible' });
return JSON.stringify({ indexedItems, heading: 'Conferências', destinationReady: true });`;
    case "multi-frame-form":
      return `${frame}
await content().locator('#query').fill('consulta legacy');
await content().locator('#category').selectOption('recent');
await content().locator('#query').press('ArrowRight');
const query = await content().locator('#query').inputValue();
const category = await content().locator('#category').inputValue();
return JSON.stringify({ query, category, asserted: query === 'consulta legacy' });`;
    case "controlled-postback":
      return `${frame}
await content().locator('#confirm-post').evaluate((element) => element.click());
await content().locator('#postback-heading').waitFor({ state: 'visible', timeout: 10000 });
const postCount = Number(await content().locator('#post-count').innerText());
return JSON.stringify({ confirmation: { applicable: false, supported: false, challenged: false }, documentReplaced: true, postCount });`;
    default:
      throw new Error(`Unsupported VS Code batch flow: ${flowId}.`);
  }
}

async function prepareVsCodePage(client, pageId, url) {
  const segmented = url.includes("segmented-index.html");
  const menuSelector = segmented ? "#financeiro-segmented" : "#financeiro";
  const contentSelector = segmented ? "#initial-content" : "h1";
  await mcpCall(client, "run_playwright_code", {
    pageId,
    code: `await page.goto(${JSON.stringify(url)}, { waitUntil: 'load', timeout: 15000 });
const menu = page.frames().find((candidate) => candidate.name() === 'Menu');
const content = page.frames().find((candidate) => candidate.name() === 'MenuContent');
await menu.locator(${JSON.stringify(menuSelector)}).waitFor({ state: 'visible', timeout: 10000 });
await content.locator(${JSON.stringify(contentSelector)}).waitFor({ state: 'visible', timeout: 10000 });
return page.url();`,
    timeoutMs: 15_000,
  });
}

async function openWorkerTab(call, url, purpose) {
  const opened = await call("open", {
    url,
    purpose: `flow-benchmark-${purpose}`,
    reusable: false,
    protected: false,
    sticky: false,
  });
  const tabId = opened?.tab?.tabId;
  if (typeof tabId !== "string") throw new Error("Browser Worker returned no benchmark tabId.");
  const segmented = url.includes("segmented-index.html");
  const poisoned = url.includes("variant=poison");
  try {
    await call("frameSequence", {
      tabId,
      steps: [
        {
          action: "waitFor",
          framePath: ["Menu"],
          locator: {
            selector: segmented
              ? "#financeiro-segmented"
              : poisoned
                ? "#financeiro-poison"
                : "#financeiro",
          },
          state: "visible",
          timeoutMs: 10_000,
        },
        {
          action: "waitFor",
          framePath: ["MenuContent"],
          locator: {
            selector: segmented ? "#initial-content" : "h1",
          },
          state: "visible",
          timeoutMs: 10_000,
        },
      ],
      timeoutMs: 10_000,
    });
  } catch (error) {
    await closeWorkerTab(call, tabId);
    throw error;
  }
  return { tabId, opened };
}

async function closeWorkerTab(call, tabId) {
  await call("closeTab", { tabId }).catch(() => undefined);
}

function menuInput(tabId, supportsNavigationCheckpoint) {
  return {
    tabId,
    path: MENU_PATH,
    sourceFramePath: ["Menu"],
    targetFramePath: ["MenuContent"],
    ...(supportsNavigationCheckpoint
      ? {
          checkpoint: {
            action: "extract",
            framePath: ["MenuContent"],
            locator: { selector: "h1" },
            format: "text",
          },
        }
      : {}),
    timeoutMs: 10_000,
  };
}

function largeMenuInput(tabId, supportsNavigationCheckpoint) {
  return {
    tabId,
    path: LARGE_MENU_PATH,
    segments: [
      {
        framePath: ["Menu"],
        rootSelector: "#main-menu",
        path: ["Financeiro", "CPX-Finance"],
        targetFramePath: ["MenuContent"],
      },
      {
        framePath: ["MenuContent"],
        path: ["Histórico", "Conferências"],
        waitFor: {
          locator: { selector: '.tab.is-active[data-view="conferencias"]' },
          state: "visible",
          timeoutMs: 2_000,
        },
      },
    ],
    ...(supportsNavigationCheckpoint
      ? {
          checkpoint: {
            action: "extract",
            framePath: ["MenuContent"],
            locator: { selector: ".tab.is-active" },
            format: "text",
          },
        }
      : {}),
    timeoutMs: 10_000,
  };
}

async function navigateWithCheckpoint(meter, call, input, fallbackStep) {
  const result = await meter.call(call, "navigatePath", input);
  if (result.checkpoint) return result;
  const fallback = await meter.call(call, "frameSequence", {
    tabId: input.tabId,
    steps: [fallbackStep],
    timeoutMs: input.timeoutMs,
  });
  const step = fallback.steps?.[0];
  if (!step) throw new Error("Navigation fallback checkpoint returned no step.");
  return {
    ...result,
    checkpoint: { step, telemetry: fallback.telemetry },
    telemetry: combineTelemetry([result.telemetry, fallback.telemetry]),
  };
}

async function measureCalls(context, run) {
  const meter = {
    toolCalls: 0,
    requestBytes: 0,
    responseBytes: 0,
    transportMs: 0,
    toolRoundTripMs: 0,
    engineMs: 0,
    fastPathCalls: 0,
    gatewayTimings: [],
    async call(call, operation, input) {
      this.toolCalls += 1;
      this.requestBytes += Buffer.byteLength(
        JSON.stringify({ operation, input }),
        "utf8",
      );
      const result = await call(operation, input);
      const roundTripMs = Number(result?.__benchmarkTransport?.elapsedMs ?? 0);
      const engineMs = Number(result?.telemetry?.totalMs ?? 0);
      if (
        result?.__benchmarkTransport?.route ===
        "legacy-browser-fast-path-v1"
      ) {
        this.fastPathCalls += 1;
      }
      const gatewayTiming = result?.__benchmarkTransport?.gatewayTiming;
      if (gatewayTiming && typeof gatewayTiming === "object") {
        this.gatewayTimings.push(gatewayTiming);
      }
      this.responseBytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      this.toolRoundTripMs += roundTripMs;
      this.engineMs += engineMs;
      this.transportMs += Math.max(0, roundTripMs - engineMs);
      return result;
    },
    async mcp(client, name, args) {
      const result = await mcpCall(client, name, args);
      this.toolCalls += result.callCount;
      this.requestBytes += result.requestBytes;
      this.responseBytes += result.bytes;
      this.toolRoundTripMs += result.elapsedMs;
      this.transportMs += result.elapsedMs;
      return result;
    },
  };
  const startedAt = performance.now();
  const value = await run(meter);
  return {
    phase: context.phase,
    durationMs: elapsed(startedAt),
    requestBytes: meter.requestBytes,
    responseBytes: meter.responseBytes,
    toolCalls: meter.toolCalls,
    transportMs: meter.transportMs,
    toolRoundTripMs: meter.toolRoundTripMs,
    engineMs: meter.engineMs,
    fastPathCalls: meter.fastPathCalls,
    gatewayTimings: meter.gatewayTimings,
    value,
  };
}

function finalizeMeasuredSample(measured, observation, internalTiming, extras = {}) {
  const postcondition = validateFlowPostcondition(extras.flowId ?? inferFlowId(observation), observation);
  return {
    phase: measured.phase,
    success: postcondition,
    durationMs: measured.durationMs,
    comparisonDurationMs:
      measured.comparisonDurationMs ?? measured.durationMs,
    ...(measured.protocolDurationMs === undefined
      ? {}
      : { protocolDurationMs: measured.protocolDurationMs }),
    ...(measured.executionDurationMs === undefined
      ? {}
      : { executionDurationMs: measured.executionDurationMs }),
    requestBytes: measured.requestBytes ?? 0,
    responseBytes: measured.responseBytes,
    toolCalls: measured.toolCalls,
    transportMs: measured.transportMs,
    toolRoundTripMs: measured.toolRoundTripMs,
    engineMs: measured.engineMs,
    fastPathCalls: measured.fastPathCalls ?? 0,
    gatewayTimings: measured.gatewayTimings ?? [],
    ...(measured.comparisonRequestBytes === undefined
      ? {}
      : { comparisonRequestBytes: measured.comparisonRequestBytes }),
    ...(measured.comparisonResponseBytes === undefined
      ? {}
      : { comparisonResponseBytes: measured.comparisonResponseBytes }),
    ...(measured.comparisonToolCalls === undefined
      ? {}
      : { comparisonToolCalls: measured.comparisonToolCalls }),
    ...(measured.comparisonTransportMs === undefined
      ? {}
      : { comparisonTransportMs: measured.comparisonTransportMs }),
    ...(measured.comparisonToolRoundTripMs === undefined
      ? {}
      : { comparisonToolRoundTripMs: measured.comparisonToolRoundTripMs }),
    ...(measured.comparisonEngineMs === undefined
      ? {}
      : { comparisonEngineMs: measured.comparisonEngineMs }),
    ...(measured.comparisonFastPathCalls === undefined
      ? {}
      : { comparisonFastPathCalls: measured.comparisonFastPathCalls }),
    ...(measured.comparisonGatewayTimings === undefined
      ? {}
      : { comparisonGatewayTimings: measured.comparisonGatewayTimings }),
    postcondition,
    observation,
    internalTiming,
    ...Object.fromEntries(Object.entries(extras).filter(([, value]) => value !== undefined)),
  };
}

function inferFlowId(observation) {
  if ("confirmationRequired" in observation || "confirmation" in observation) {
    return "controlled-postback";
  }
  if ("indexedItems" in observation) return "large-menu";
  if ("query" in observation) return "multi-frame-form";
  if (
    observation?.cache?.revalidated ||
    observation?.executionPhase === "repeat"
  ) {
    return "legacy-menu-warm";
  }
  return "legacy-menu-cold";
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

function combineTelemetry(entries) {
  const present = entries.filter(Boolean);
  return {
    totalMs: round(present.reduce((sum, entry) => sum + Number(entry.totalMs ?? 0), 0)),
    candidateCount: present.reduce((sum, entry) => sum + Number(entry.candidateCount ?? 0), 0),
    retries: present.reduce((sum, entry) => sum + Number(entry.retries ?? 0), 0),
    strategy: present.map((entry) => entry.strategy).filter(Boolean).join("+"),
  };
}

export async function mcpCall(client, name, args) {
  const startedAt = performance.now();
  let currentArgs = args;
  let bytes = 0;
  let requestBytes = 0;
  let callCount = 0;
  for (let continuation = 0; continuation <= 20; continuation += 1) {
    requestBytes += Buffer.byteLength(
      JSON.stringify({ name, arguments: currentArgs }),
      "utf8",
    );
    const result = await client.callTool(name, currentArgs);
    callCount += 1;
    bytes += Buffer.byteLength(JSON.stringify(result), "utf8");
    if (result?.isError) {
      throw new Error(`${name} failed: ${toolText(result)}`);
    }
    const deferredResultId = name === "run_playwright_code"
      ? /\[deferredResultId=([A-Za-z0-9_-]+)\]/u.exec(toolText(result))?.[1]
      : undefined;
    if (!deferredResultId) {
      if (
        name === "run_playwright_code" &&
        !/(?:^|\n)(?:Result|Resultado|Playwright result):/iu.test(toolText(result))
      ) {
        throw new Error(`${name} failed: ${toolText(result)}`);
      }
      return {
        result,
        bytes,
        requestBytes,
        callCount,
        elapsedMs: elapsed(startedAt),
      };
    }
    currentArgs = {
      pageId: args.pageId,
      deferredResultId,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    };
  }
  throw new Error("run_playwright_code exceeded 20 deferred continuations.");
}

function parseVsCodePages(result) {
  try {
    const parsed = JSON.parse(toolText(result));
    if (!Array.isArray(parsed?.pages)) throw new Error("missing pages");
    return parsed.pages;
  } catch (error) {
    throw new Error(`VS Code page discovery returned invalid JSON: ${toolText(result).slice(0, 500)}`, {
      cause: error,
    });
  }
}

export function extractToolResult(result) {
  const text = toolText(result);
  const patterns = [
    /(?:^|\n)(?:Result|Resultado):\s*([\s\S]*?)(?=\n(?:Page Title|URL|Snapshot|Page state|Estado da página):|$)/iu,
    /(?:^|\n)(?:Playwright result):\s*([\s\S]*?)(?:\n|$)/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return stripQuotes(match[1].trim());
  }
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
  return stripQuotes(firstLine.trim());
}

function parseJsonToolResult(value) {
  const candidates = [
    value,
    value.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, ""),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "string") return JSON.parse(parsed);
      return parsed;
    } catch {
      // Try the next normalized representation.
    }
  }
  throw new Error(`VS Code batch returned invalid JSON: ${value.slice(0, 500)}`);
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function frameActionCode(frameName, selector, action, includeReturn = true, value) {
  const invocation = action === "click"
    ? "evaluate((element) => element.click())"
    : `${action}(${JSON.stringify(value)})`;
  return `const frame = page.frames().find((candidate) => candidate.name() === ${JSON.stringify(frameName)});
await frame.locator(${JSON.stringify(selector)}).${invocation};
${includeReturn ? `return ${JSON.stringify(action)};` : ""}`;
}

function toolText(result) {
  return (result?.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");
}

function elapsed(startedAt) {
  return round(performance.now() - startedAt);
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Benchmark operation exceeded ${timeoutMs}ms.`)),
        timeoutMs,
      );
      timeout.unref();
    }),
  ]);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
