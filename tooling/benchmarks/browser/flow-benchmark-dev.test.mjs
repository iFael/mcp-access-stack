import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDevWorkerAdapter,
  deriveCpxMenuStructure,
  ensureCpxReady,
  ensureDevHome,
  isDevCpxAvailable,
  isDevMenuAuthenticated,
  isExpectedCpxAbsence,
  navigateMeasuredCpx,
  openDevTab,
  waitForCpxReady,
  waitForDevHome,
  waitForDevPanelActive,
  waitForDevPanelTarget,
  waitForDevWorkerAuthenticated,
  waitForManualDevAuthSignal,
} from "./flow-benchmark-dev.mjs";

const TEST_MENU_STRUCTURE = Object.freeze({
  financeCollapsedRootSelector: "#Plus569",
  financeExpandedRootSelector: "#Minus569",
  financeClickSelector: "#Plus569 > table",
  financeClickIndex: 0,
  cpxClickSelector: "#anchor_590_2",
  cpxClickIndex: 0,
  cpxVisibleRootSelector: "#DataOpenned590 font",
  cpxVisibleLinkSelector: "#anchor_590_2",
});

const AUTHENTICATED_FINANCE_ITEMS = [
  {
    text: "Financeiro",
    visible: true,
    selector: "#Plus569 > table",
    ancestors: ["div #Plus569", "div #MainMenu_1"],
  },
  {
    text: "Financeiro",
    visible: false,
    selector: "#Minus569 > table",
    ancestors: ["div #Minus569", "div #MainMenu_1"],
  },
];

const AUTHENTICATED_CPX_ITEMS = [
  {
    text: "CPX-Finance",
    visible: false,
    selector: "#anchor_590_2",
    ancestors: ["font", "div #DataOpenned590", "div #Div569"],
  },
];

test("detects an authenticated Dev menu with visible Financeiro and CPX access", () => {
  assert.equal(isDevMenuAuthenticated({
    items: [{ text: "Financeiro", visible: true }],
  }), true);
  assert.equal(isDevMenuAuthenticated({
    items: [{ text: "Financeiro", visible: false }],
  }), false);
  assert.equal(isDevMenuAuthenticated({ items: [{ text: "Login", visible: true }] }), false);
  assert.equal(isDevCpxAvailable({ items: [{ text: "CPX-Finance", visible: false }] }), true);
  assert.equal(isDevCpxAvailable({ items: [] }), false);
  assert.deepEqual(deriveCpxMenuStructure(
    { items: AUTHENTICATED_FINANCE_ITEMS },
    { items: AUTHENTICATED_CPX_ITEMS },
  ), TEST_MENU_STRUCTURE);
});

test("waits for visible Financeiro and CPX access to become ready", async () => {
  let polls = 0;
  const call = async (operation, input) => {
    assert.equal(operation, "domIndex");
    assert.equal(input.tabId, "dev-tab");
    if (input.query === "Financeiro") {
      polls += 1;
      return polls < 3
        ? { items: [{ text: "Financeiro", visible: false }] }
        : { items: AUTHENTICATED_FINANCE_ITEMS };
    }
    assert.equal(input.query, "CPX-Finance");
    return polls < 3
      ? { items: [] }
      : { items: AUTHENTICATED_CPX_ITEMS };
  };

  assert.deepEqual(await waitForDevWorkerAuthenticated(call, "dev-tab", "candidate", {
    timeoutMs: 500,
    pollMs: 5,
  }), TEST_MENU_STRUCTURE);
  assert.equal(polls, 3);
});

test("waits for a fresh manual Dev authentication signal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-auth-signal-"));
  const signal = path.join(root, "ready.flag");
  try {
    const waiting = waitForManualDevAuthSignal(signal, { timeoutMs: 2_000, pollMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(signal, "ready\n", "utf8");
    assert.equal(await waiting, path.resolve(signal));
    await assert.rejects(
      waitForManualDevAuthSignal(signal, { timeoutMs: 100, pollMs: 10 }),
      /already exists/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opens a Dev tab without reloading the authenticated session", async () => {
  const calls = [];
  const call = async (operation, input) => {
    calls.push({ operation, input });
    if (operation === "open") {
      return { tab: { tabId: "dev-tab", url: "https://dev-private.example.test/app" } };
    }
    throw new Error(`Unexpected operation: ${operation}`);
  };
  assert.equal(
    await openDevTab(call, "https://dev-private.example.test/app", "sample"),
    "dev-tab",
  );
  assert.deepEqual(calls.map(({ operation }) => operation), ["open"]);
});

test("recovers a Dev tab after an internal open response failure", async () => {
  const calls = [];
  const call = async (operation, input) => {
    calls.push({ operation, input });
    if (operation === "open") {
      const error = new Error("response failed after page creation");
      error.code = "INTERNAL_ERROR";
      throw error;
    }
    assert.equal(operation, "tabs");
    return {
      tabs: [{
        tabId: "recovered-tab",
        url: "https://dev-private.example.test/app",
        lastUsedAt: "2026-07-31T00:00:00.000Z",
      }],
    };
  };
  assert.equal(
    await openDevTab(call, "https://dev-private.example.test/app", "recovery"),
    "recovered-tab",
  );
  assert.deepEqual(calls.map(({ operation }) => operation), ["open", "tabs"]);
});

test("reuses the manually authenticated tab without opening or closing another tab", async () => {
  const calls = [];
  const call = async (operation, input) => {
    calls.push({ operation, input });
    if (operation === "profilePage") {
      return { frames: [{ name: "Menu", children: [] }, { name: "MenuContent", children: [] }] };
    }
    if (operation === "frameSequence" && input.steps.length === 5) {
      return {
        steps: [
          { completed: true, value: "CPX-Finance" },
          { completed: true },
          { completed: true },
          { completed: true },
          { completed: true },
        ],
      };
    }
    if (operation === "frameSequence" && input.steps.length === 1) {
      const selector = input.steps[0]?.locator?.selector;
      if (selector === ".finc-fila-view-tab.is-active") {
        return { steps: [{ completed: true, value: "Confer\u00eancias" }] };
      }
      const error = new Error("results not loaded yet");
      error.code = "LOCATOR_NOT_FOUND";
      throw error;
    }
    throw new Error(`Unexpected operation: ${operation}`);
  };
  const adapter = createDevWorkerAdapter(
    "previous",
    call,
    { url: "https://dev-private.example.test/app" },
    {
      tabId: "authenticated-tab",
      navigationState: { structure: TEST_MENU_STRUCTURE },
    },
  );
  assert.equal(await adapter.preflight(), true);
  assert.deepEqual(calls.map(({ operation }) => operation), ["profilePage", "frameSequence", "frameSequence", "frameSequence"]);
  assert.ok(calls.every(({ input }) => input.tabId === "authenticated-tab"));
});

test("restores Dev home and collapses the expanded Financeiro menu", async () => {
  const calls = [];
  let atHome = false;
  let financeCollapsed = false;
  const call = async (operation, input) => {
    calls.push({ operation, input });
    if (operation === "navigatePath") {
      assert.deepEqual(input, {
        tabId: "dev-tab",
        path: ["Novidades (Home)"],
        sourceFramePath: ["Menu"],
        targetFramePath: ["MenuContent"],
        segments: [{
          framePath: ["Menu"],
          path: ["Novidades (Home)"],
          rootSelector: "#DataClosed3 font",
          targetFramePath: ["MenuContent"],
        }],
        timeoutMs: 30_000,
      });
      atHome = true;
      return { completed: true, destinationReady: true };
    }
    if (operation === "domIndex") {
      assert.equal(input.rootSelector, "#Minus569");
      assert.equal(input.visibleOnly, true);
      return {
        items: [{ ref: "finance-expanded-ref", text: "Financeiro", visible: true }],
      };
    }
    assert.equal(operation, "frameSequence");
    const firstStep = input.steps[0];
    if (firstStep?.action === "click" && firstStep.locator?.ref) {
      assert.deepEqual(firstStep.locator, { ref: "finance-expanded-ref" });
      financeCollapsed = true;
      return { steps: [{ completed: true }] };
    }
    if (input.steps.length === 5) {
      if (atHome) {
        const error = new Error("CPX no longer active");
        error.code = "LOCATOR_NOT_FOUND";
        throw error;
      }
      return {
        steps: [
          { completed: true, value: "CPX-Finance" },
          { completed: true },
          { completed: true },
          { completed: true },
          { completed: true },
        ],
      };
    }
    const error = new Error("results not loaded yet");
    error.code = "LOCATOR_NOT_FOUND";
    throw error;
  };
  const result = await ensureDevHome(call, "dev-tab", TEST_MENU_STRUCTURE);
  assert.equal(result.destinationReady, true);
  assert.equal(atHome, true);
  assert.equal(financeCollapsed, true);
});

test("accepts a completed CPX navigation after a recoverable CPX click error", async () => {
  let stateReads = 0;
  let menuClicks = 0;
  const call = async (operation, input) => {
    if (operation === "domIndex") return { items: [] };
    if (operation === "frameClick") {
      menuClicks += 1;
      if (menuClicks === 1) {
        assert.deepEqual(input, {
          tabId: "dev-tab",
          frame: "Menu",
          selector: "#Plus569 > table",
          index: 0,
        });
        return { completed: true };
      }
      assert.deepEqual(input, {
        tabId: "dev-tab",
        frame: "Menu",
        selector: "#anchor_590_2",
        index: 0,
      });
      const error = new Error("destination frame change was not observed");
      error.code = "STATE_NOT_REACHED";
      throw error;
    }
    assert.equal(operation, "frameSequence");
    const step = input.steps[0];
    if (step?.action === "waitFor" && step.framePath?.[0] === "Menu") {
      return { steps: [{ completed: true }] };
    }
    if (input.steps.length === 5) {
      stateReads += 1;
      if (stateReads === 1) {
        const error = new Error("CPX not ready yet");
        error.code = "LOCATOR_NOT_FOUND";
        throw error;
      }
      return {
        steps: [
          { completed: true, value: "CPX-Finance" },
          { completed: true },
          { completed: true },
          { completed: true },
          { completed: true },
        ],
      };
    }
    const error = new Error("results not loaded yet");
    error.code = "LOCATOR_NOT_FOUND";
    throw error;
  };

  const result = await ensureCpxReady(call, "dev-tab", TEST_MENU_STRUCTURE);
  assert.equal(result.destinationReady, true);
  assert.deepEqual(result.recoveries, [{ phase: "cpx", code: "STATE_NOT_REACHED" }]);
  assert.equal(result.telemetry.strategy, "postcondition-recovered-selector-index-frame-clicks");
  assert.equal(menuClicks, 2);
  assert.equal(stateReads, 2);
});

test("accepts a Financeiro click timeout only when the submenu becomes visible", async () => {
  let stateReads = 0;
  let menuClicks = 0;
  const call = async (operation, input) => {
    if (operation === "domIndex") return { items: [] };
    if (operation === "frameClick") {
      menuClicks += 1;
      if (menuClicks === 1) {
        const error = new Error("menu response timed out after click");
        error.code = "NAVIGATION_TIMEOUT";
        throw error;
      }
      assert.equal(input.selector, "#anchor_590_2");
      return { completed: true };
    }
    assert.equal(operation, "frameSequence");
    const step = input.steps[0];
    if (step?.action === "waitFor" && step.framePath?.[0] === "Menu") {
      return { steps: [{ completed: true }] };
    }
    if (input.steps.length === 5) {
      stateReads += 1;
      if (stateReads === 1) {
        const error = new Error("CPX not ready before navigation");
        error.code = "LOCATOR_NOT_FOUND";
        throw error;
      }
      return {
        steps: [
          { completed: true, value: "CPX-Finance" },
          { completed: true },
          { completed: true },
          { completed: true },
          { completed: true },
        ],
      };
    }
    const error = new Error("results not loaded yet");
    error.code = "LOCATOR_NOT_FOUND";
    throw error;
  };

  const result = await ensureCpxReady(call, "dev-tab", TEST_MENU_STRUCTURE);
  assert.equal(result.destinationReady, true);
  assert.deepEqual(result.recoveries, [{ phase: "finance", code: "NAVIGATION_TIMEOUT" }]);
  assert.equal(menuClicks, 2);
  assert.equal(stateReads, 2);
});

test("measures deterministic CPX clicks and postcondition recovery", async () => {
  let stateReads = 0;
  let menuClicks = 0;
  const meter = {
    toolCalls: 0,
    responseBytes: 0,
    async call(targetCall, operation, input) {
      this.toolCalls += 1;
      const result = await targetCall(operation, input);
      this.responseBytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      return result;
    },
  };
  const call = async (operation, input) => {
    if (operation === "frameClick") {
      menuClicks += 1;
      if (menuClicks === 2) {
        const error = new Error("destination frame change was not observed");
        error.code = "STATE_NOT_REACHED";
        throw error;
      }
      return { completed: true };
    }
    assert.equal(operation, "frameSequence");
    const step = input.steps[0];
    if (step?.action === "waitFor" && step.framePath?.[0] === "Menu") {
      return { steps: [{ completed: true }] };
    }
    if (input.steps.length === 5) {
      stateReads += 1;
      return {
        steps: [
          { completed: true, value: "CPX-Finance" },
          { completed: true },
          { completed: true },
          { completed: true },
          { completed: true },
        ],
      };
    }
    const error = new Error("results not loaded yet");
    error.code = "LOCATOR_NOT_FOUND";
    throw error;
  };

  const result = await navigateMeasuredCpx(meter, call, "dev-tab", TEST_MENU_STRUCTURE);
  assert.equal(result.destinationReady, true);
  assert.deepEqual(result.recoveries, [{ phase: "cpx", code: "STATE_NOT_REACHED" }]);
  assert.equal(result.telemetry.strategy, "postcondition-recovered-selector-index-frame-clicks");
  assert.equal(menuClicks, 2);
  assert.ok(meter.toolCalls >= 4);
  assert.ok(stateReads >= 1);
});

test("waits for the next Dev panel target without clicking it", async () => {
  let attempts = 0;
  const meter = {
    call: async (call, operation, input) => call(operation, input),
  };
  const call = async (operation, input) => {
    assert.equal(operation, "frameSequence");
    assert.equal(input.steps.length, 1);
    assert.equal(input.steps[0].action, "assert");
    assert.equal(input.steps[0].condition, "exists");
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("replacement document is not ready");
      error.code = attempts === 1 ? "INTERNAL_ERROR" : "LOCATOR_NOT_FOUND";
      throw error;
    }
    return { steps: [{ completed: true }] };
  };

  assert.deepEqual(await waitForDevPanelTarget(
    meter,
    call,
    "dev-tab",
    "button.panel",
    { timeoutMs: 500, pollMs: 5 },
  ), { ready: true });
  assert.equal(attempts, 3);
});

test("observes a Dev panel after transient frame replacement errors", async () => {
  let attempts = 0;
  const meter = {
    call: async (call, operation, input) => call(operation, input),
  };
  const call = async (operation, input) => {
    assert.equal(operation, "frameSequence");
    assert.equal(input.steps[0].action, "extract");
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("frame is replacing");
      error.code = attempts === 1 ? "INTERNAL_ERROR" : "LOCATOR_NOT_FOUND";
      throw error;
    }
    return { steps: [{ completed: true, value: "Pendencias (0)" }] };
  };

  assert.equal(await waitForDevPanelActive(
    meter,
    call,
    "dev-tab",
    "button.active",
    { timeoutMs: 500, pollMs: 5 },
  ), "Pendencias (0)");
  assert.equal(attempts, 3);
});

test("retries a transient internal frame error while waiting for Dev home", async () => {
  let attempts = 0;
  const call = async () => {
    attempts += 1;
    const error = new Error(attempts === 1 ? "document is replacing" : "CPX absent");
    error.code = attempts === 1 ? "INTERNAL_ERROR" : "LOCATOR_NOT_FOUND";
    throw error;
  };

  assert.deepEqual(await waitForDevHome(call, "dev-tab", {
    timeoutMs: 500,
    pollMs: 5,
  }), { ready: true });
  assert.equal(attempts, 2);
});

test("collapses Financeiro even when Dev is already on home", async () => {
  let collapsed = false;
  const call = async (operation, input) => {
    assert.notEqual(operation, "navigatePath");
    if (operation === "domIndex") {
      return { items: [{ ref: "expanded-ref", text: "Financeiro", visible: true }] };
    }
    assert.equal(operation, "frameSequence");
    if (input.steps[0]?.locator?.ref === "expanded-ref") {
      collapsed = true;
      return { steps: [{ completed: true }] };
    }
    const error = new Error("CPX is not active");
    error.code = "LOCATOR_NOT_FOUND";
    throw error;
  };
  const result = await ensureDevHome(call, "dev-tab", TEST_MENU_STRUCTURE);
  assert.deepEqual(result, { alreadyHome: true });
  assert.equal(collapsed, true);
});

test("accepts CPX-Finance before the first results area is created", async () => {
  let primaryAttempts = 0;
  let resultAttempts = 0;
  const call = async (operation, input) => {
    assert.equal(operation, "frameSequence");
    if (input.steps.length === 5) {
      primaryAttempts += 1;
      const ready = primaryAttempts >= 3;
      return {
        steps: [
          { completed: true, value: ready ? "CPX-Finance" : "" },
          { completed: ready },
          { completed: ready },
          { completed: ready },
          { completed: ready },
        ],
      };
    }
    resultAttempts += 1;
    const error = new Error("results not loaded yet");
    error.code = "LOCATOR_NOT_FOUND";
    throw error;
  };
  const page = await waitForCpxReady(call, "dev-tab", { timeoutMs: 500, pollMs: 5 });
  assert.equal(primaryAttempts, 3);
  assert.equal(resultAttempts, 3);
  assert.equal(page.header, true);
  assert.equal(page.filters, true);
  assert.equal(page.resultsArea, false);
});

test("accepts structured transient CPX errors without relying on instanceof", () => {
  assert.equal(isExpectedCpxAbsence({ code: "LOCATOR_NOT_FOUND" }), true);
  assert.equal(isExpectedCpxAbsence({ code: "STATE_NOT_REACHED" }), true);
  assert.equal(isExpectedCpxAbsence({ code: "ACTION_BLOCKED_BY_POLICY" }), false);
  assert.equal(isExpectedCpxAbsence(new Error("missing")), false);
});
