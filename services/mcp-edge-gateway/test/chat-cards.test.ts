import { describe, expect, it } from "@jest/globals";
import { runInNewContext, Script } from "node:vm";
import { CARD_MCP_APPS_SCRIPT } from "../src/control-plane/card-style.js";
import { ProgressPlans, PROGRESS_CARD_URI } from "../src/control-plane/progress-card.js";
import { PULL_REQUEST_CARD_URI } from "../src/control-plane/pull-request-card.js";
import { USER_MESSAGES_CARD_URI, uiResourcesForManifest } from "../src/control-plane/user-messages-card.js";

function call(name: string, args: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function result(response: Response | null) {
  expect(response).not.toBeNull();
  return (await response!.json() as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }).result;
}

function memory() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
  };
}

describe("the plan card", () => {
  it("binds a plan to the originating MCP session, not another conversation", async () => {
    const storage = memory();
    let index = 0;
    const plans = new ProgressPlans(storage, () => new Date("2026-11-02T22:00:00.000Z"),
      () => `plan_00000000-0000-4000-8000-00000000000${++index}`);
    const forSession = (session: string) => ({
      ...call("browser_progress", { title: "Test", steps: [{ text: "Work", state: "doing" }] }),
      params: { ...call("browser_progress", { title: "Test", steps: [{ text: "Work", state: "doing" }] }).params, _meta: { "openai/session": session } },
    });
    const first = await result(await plans.handle(forSession("chat-a"), "user_1"));
    const second = await result(await plans.handle(forSession("chat-b"), "user_1"));
    expect(first.structuredContent?.planId).toMatch(/^plan_/);
    expect(second.structuredContent?.planId).toMatch(/^plan_/);
    expect(first.structuredContent?.planId).not.toBe(second.structuredContent?.planId);
    expect(await plans.planForSession("user_1", "chat-a")).toBe(first.structuredContent?.planId);
    expect(await plans.planForSession("user_1", "chat-b")).toBe(second.structuredContent?.planId);
    expect(await plans.planForSession("user_2", "chat-a")).toBeUndefined();
    // A plan already shown in this conversation can be rebound after a reconnection.
    const shownCall = call("browser_progress", { planId: first.structuredContent?.planId });
    const shown = { ...shownCall, params: { ...shownCall.params, _meta: { "openai/session": "chat-reconnected" } } };
    expect((await result(await plans.handle(shown, "user_1"))).isError).not.toBe(true);
    expect(await plans.planForSession("user_1", "chat-reconnected")).toBe(first.structuredContent?.planId);
  });

  const steps = [{ text: "Ler o código", state: "done" }, { text: "Corrigir", state: "doing" }, { text: "Publicar", state: "todo" }];

  it("opens one plan, changes it in place and lets the card read the latest", async () => {
    let ids = 0;
    const plans = new ProgressPlans(memory(), () => new Date("2026-10-29T02:00:00.000Z"),
      () => `plan_00000000-0000-4000-8000-00000000000${++ids}`);
    const opened = await result(await plans.handle(call("browser_progress", { title: "Corrigir o CI", steps, deviceId: "dev_x" }), "user_1"));
    expect(opened.structuredContent).toEqual({ planId: "plan_00000000-0000-4000-8000-000000000001", title: "Corrigir o CI",
      steps: [steps[0], { ...steps[1], startedAt: "2026-10-29T02:00:00.000Z" }, steps[2]],
      updatedAt: "2026-10-29T02:00:00.000Z", shownAt: "2026-10-29T02:00:00.000Z" });
    expect(opened.content[0]!.text).toContain("browser_progress_update");

    const planId = opened.structuredContent!.planId;
    const finished = steps.map((step) => ({ ...step, state: "done" }));
    const updated = await result(await plans.handle(call("browser_progress_update", { planId, steps: finished }), "user_1"));
    expect(updated.structuredContent).toMatchObject({ planId, title: "Corrigir o CI", steps: finished });
    expect(updated.content[0]!.text).toBe("Plan updated: 3/3 done.");

    const read = await result(await plans.handle(call("browser_progress_read", { planId }), "user_1"));
    expect(read.structuredContent).toMatchObject({ steps: finished });
    // Another user does not see it.
    expect((await result(await plans.handle(call("browser_progress_read", { planId }), "user_2"))).isError).toBe(true);
  });

  it("follows a runtime's steps on a plan the agent opened, and nothing else", async () => {
    let ids = 0;
    const storage = memory();
    const plans = new ProgressPlans(storage, () => new Date("2026-10-29T03:00:00.000Z"),
      () => `plan_00000000-0000-4000-8000-0000000000${String(++ids).padStart(2, "0")}`);
    const opened = await result(await plans.handle(call("browser_progress", { title: "Atualizar o MCP", steps }), "user_1"));
    const planId = opened.structuredContent!.planId as string;
    const moved = [{ text: "Catálogo do Edge", state: "skipped" as const }, { text: "Release do conector", state: "failed" as const }];

    expect(await plans.applyUpdate({ planId, steps: moved })).toBe(true);
    expect((await result(await plans.handle(call("browser_progress_read", { planId }), "user_1"))).structuredContent)
      .toEqual({ planId, title: "Atualizar o MCP", steps: moved, updatedAt: "2026-10-29T03:00:00.000Z",
        shownAt: "2026-10-29T03:00:00.000Z" });

    // A companion of another user, or a plan nobody opened, changes nothing.
    expect(await plans.applyUpdate({ planId, steps }, "user_2")).toBe(false);
    expect(await plans.applyUpdate({ planId: "plan_00000000-0000-4000-8000-000000000099", steps })).toBe(false);
    expect(await plans.applyUpdate({ planId, title: "Atualizar", steps }, "user_1")).toBe(true);

    // Plans past the last 20 are forgotten, and so is who owned them.
    for (let index = 0; index < 20; index += 1) {
      await plans.handle(call("browser_progress", { title: `Plano ${index}`, steps }), "user_1");
    }
    expect(storage.values.has(`progress-plan-owner:${planId}`)).toBe(false);
    expect(await plans.applyUpdate({ planId, steps })).toBe(false);
  });

  it("times each step, says why it waits and shows the card again where the answer is", async () => {
    let now = "2026-10-30T10:00:00.000Z";
    const plans = new ProgressPlans(memory(), () => new Date(now), () => "plan_00000000-0000-4000-8000-000000000001");
    const planId = "plan_00000000-0000-4000-8000-000000000001";
    const start = [{ text: "Build", state: "doing" }, { text: "Prepare", state: "todo" }];
    await plans.handle(call("browser_progress", { title: "Atualizar", steps: start }), "user_1");
    now = "2026-10-30T10:07:00.000Z";
    const link = "https://github.com/iFael/mcp-access-stack/actions/runs/41";
    expect(await plans.applyUpdate({ planId, steps: [{ text: "Build", state: "done", link },
      { text: "Prepare", state: "doing", detail: "Instalando no Windows" }] })).toBe(true);
    now = "2026-10-30T10:09:00.000Z";
    const shown = await result(await plans.handle(call("browser_progress", { planId }), "user_1"));
    expect(shown.structuredContent).toMatchObject({
      shownAt: "2026-10-30T10:09:00.000Z",
      steps: [
        { text: "Build", state: "done", link, startedAt: "2026-10-30T10:00:00.000Z", endedAt: "2026-10-30T10:07:00.000Z" },
        { text: "Prepare", state: "doing", detail: "Instalando no Windows", startedAt: "2026-10-30T10:07:00.000Z" },
      ],
    });
    // Showing it again changes nothing else, and takes nothing but the planId.
    expect((await result(await plans.handle(call("browser_progress", { planId, title: "x" }), "user_1"))).isError).toBe(true);
    expect((await result(await plans.handle(call("browser_progress_update", { planId,
      steps: [{ text: "Build", state: "done", link: "https://example.com/x" }] }), "user_1"))).isError).toBe(true);
  });

  it("gives mcp_update action=start its own plan, which the update then moves", async () => {
    const plans = new ProgressPlans(memory(), () => new Date("2026-10-30T20:00:00.000Z"),
      () => "plan_00000000-0000-4000-8000-000000000007");
    const body = call("mcp_update", { action: "start", workspaceId: "mcp-access-stack", expectedMainSha: "a".repeat(40) });
    await plans.openForUpdate(body, "user_1");
    expect(body.params.arguments).toMatchObject({ planId: "plan_00000000-0000-4000-8000-000000000007" });
    expect(await plans.applyUpdate({ planId: "plan_00000000-0000-4000-8000-000000000007",
      steps: [{ text: "Pré-checagem", state: "done" }] }, "user_1")).toBe(true);
    expect((await result(await plans.handle(call("browser_progress_read", { planId: "plan_00000000-0000-4000-8000-000000000007" }), "user_1")))
      .structuredContent).toMatchObject({ title: "Atualizando o MCP", steps: [{ text: "Pré-checagem", state: "done" }] });

    // A plan the agent passed, another action, another tool or no user: nothing changes.
    for (const other of [
      call("mcp_update", { action: "start", planId: "plan_00000000-0000-4000-8000-000000000001" }),
      call("mcp_update", { action: "read" }),
      call("browser_open", { url: "https://example.com" }),
    ]) {
      const before = JSON.stringify(other);
      await plans.openForUpdate(other, "user_1");
      expect(JSON.stringify(other)).toBe(before);
    }
    const anonymous = call("mcp_update", { action: "start" });
    await plans.openForUpdate(anonymous, undefined);
    expect(anonymous.params.arguments).not.toHaveProperty("planId");
  });

  it("refuses what the contract refuses and leaves other tools alone", async () => {
    const plans = new ProgressPlans(memory());
    expect((await result(await plans.handle(call("browser_progress", { title: "", steps }), "user_1"))).isError).toBe(true);
    expect((await result(await plans.handle(call("browser_progress", { title: "x", steps: [{ text: "a", state: "late" }] }), "user_1"))).isError).toBe(true);
    expect((await result(await plans.handle(call("browser_progress_update", { planId: "plan_00000000-0000-4000-8000-000000000009", steps }), "user_1"))).isError).toBe(true);
    expect(await plans.handle(call("browser_open", { url: "https://example.com" }), "user_1")).toBeNull();
  });
});

describe("the chat cards the Edge serves", () => {
  it("serves the plan and pull request cards when the catalog points at them", () => {
    const resources = uiResourcesForManifest([
      { name: "browser_progress", _meta: { ui: { resourceUri: PROGRESS_CARD_URI } } },
      { name: "github_get_pull_request", _meta: { "openai/outputTemplate": PULL_REQUEST_CARD_URI } },
    ]);
    expect(resources.map((resource) => resource.uri)).toEqual([PROGRESS_CARD_URI, PULL_REQUEST_CARD_URI]);
    expect(resources[0]!.text).toContain("browser_progress_read");
    expect(resources[0]!.uri).toBe("ui://mcp-v3/progress-v10.html");
    expect(resources[0]!.text).not.toContain('id="talk"');
    expect(resources[0]!.text).not.toContain('<textarea');
    expect(resources[0]!.text).not.toContain('id="send"');
    expect(resources[0]!.text).not.toContain("browser_user_reply");
    expect(resources[0]!.text).toContain("ui/notifications/initialized");
    expect(resources[0]!.text).toContain("veja abaixo");
    expect(resources[0]!.text).not.toContain('id="pin"');
    expect(resources[1]!.text).toContain("Abrir no GitHub");
    for (const resource of resources) {
      expect(resource.text).toContain("requestDisplayMode");
      expect(resource.text).not.toContain("${");
    }
  });

  it("keeps only the newest reply card of a task as the field; the older ones fold into a line", async () => {
    let now = new Date("2026-10-31T03:00:00.000Z");
    const plans = new ProgressPlans(memory(), () => now);
    expect((await result(await plans.handle(call("browser_user_card", { taskId: "t1" }), "user_1"))).structuredContent).toEqual({});
    const first = await plans.noteUserCard("user_1", "t1");
    now = new Date("2026-10-31T03:01:00.000Z");
    const second = await plans.noteUserCard("user_1", "t1");
    await plans.noteUserCard("user_1", "t2");
    await plans.noteUserCard("user_1", undefined);
    expect(first).not.toBe(second);
    expect((await result(await plans.handle(call("browser_user_card", { taskId: "t1" }), "user_1"))).structuredContent)
      .toEqual({ shownAt: second });
    // Another user's cards are theirs.
    expect((await result(await plans.handle(call("browser_user_card", { taskId: "t1" }), "user_2"))).structuredContent).toEqual({});

    const [card] = uiResourcesForManifest([{ name: "browser_user_messages", _meta: { ui: { resourceUri: USER_MESSAGES_CARD_URI } } }]);
    expect(card!.text).toContain("browser_user_card");
    expect(card!.text).toContain("Campo de mensagens mais abaixo");
  });

  it("tells in the reply card whether the agent has each message yet", () => {
    const [card] = uiResourcesForManifest([{ name: "browser_user_messages", _meta: { ui: { resourceUri: USER_MESSAGES_CARD_URI } } }]);
    expect(card!.uri).toBe("ui://mcp-v3/user-messages-v11.html");
    expect(card!.text).toContain("Encaminhada às");
    expect(card!.text).not.toContain("✓ Entregue às");
    expect(card!.text).toContain("aguardando o agente");
    // Clean: no title or task id over the field.
    expect(card!.text).not.toContain("Conversa com a tarefa");
    // It asks again with the same id, which never sends the message twice.
    expect(card!.text).toContain("structured.delivered === true");
    expect(card!.text).not.toContain("${");
  });

  it("sizes every card to its content, and the reply card is only the field", () => {
    const resources = uiResourcesForManifest([
      { name: "browser_progress", _meta: { ui: { resourceUri: PROGRESS_CARD_URI } } },
      { name: "github_get_pull_request", _meta: { "openai/outputTemplate": PULL_REQUEST_CARD_URI } },
      { name: "browser_user_messages", _meta: { ui: { resourceUri: USER_MESSAGES_CARD_URI } } },
    ]);
    for (const resource of resources) expect(resource.text).toContain("notifyIntrinsicHeight");
    expect(resources[2]!._meta).toMatchObject({ ui: { prefersBorder: false }, "openai/widgetPrefersBorder": false });
  });

  it("initializes MCP Apps before using native tool input and result", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const listeners = new Map<string, (event: { source?: object; data?: Record<string, unknown> }) => void>();
    const parent = { postMessage: (message: Record<string, unknown>) => { sent.push(message); } };
    const window = {
      parent,
      openai: { toolOutput: { legacy: true }, toolInput: { legacy: true }, callTool: () => Promise.resolve("legacy") },
      addEventListener: (name: string, listener: (event: { source?: object; data?: Record<string, unknown> }) => void) => {
        listeners.set(name, listener);
      },
      dispatchEvent: () => {},
    };
    runInNewContext(CARD_MCP_APPS_SCRIPT, { window, Event: class { constructor(public type: string) {} } });
    const bridge = (window as typeof window & { mcpV3Card: {
      toolInput: Record<string, unknown>; toolOutput: Record<string, unknown>; theme: string;
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    } }).mcpV3Card;
    expect(bridge.toolOutput).toEqual({ legacy: true });
    expect(await bridge.callTool("test", {})).toBe("legacy");

    const initialize = sent[0]!;
    expect(initialize).toMatchObject({ jsonrpc: "2.0", method: "ui/initialize", params: {
      protocolVersion: "2026-01-26", appInfo: { name: "mcp-v3-card" }, appCapabilities: {},
    } });
    const onMessage = listeners.get("message")!;
    onMessage({ source: {}, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: { foreign: true } } } });
    expect(bridge.toolOutput).toEqual({ legacy: true });

    onMessage({ source: parent, data: { jsonrpc: "2.0", id: initialize.id, result: {
      hostContext: { theme: "dark" },
    } } });
    await Promise.resolve();
    expect(sent[1]).toMatchObject({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(bridge.theme).toBe("dark");

    onMessage({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-input",
      params: { arguments: { taskId: "task-1" } } } });
    onMessage({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: { planId: "plan-1", steps: [] } } } });
    expect(bridge.toolInput).toEqual({ taskId: "task-1" });
    expect(bridge.toolOutput).toEqual({ planId: "plan-1", steps: [] });

    const requested = bridge.callTool("browser_progress_read", { planId: "plan-1" });
    expect(sent[2]).toMatchObject({ method: "tools/call", params: {
      name: "browser_progress_read", arguments: { planId: "plan-1" },
    } });
    onMessage({ source: parent, data: { jsonrpc: "2.0", id: sent[2]!.id, result: {
      structuredContent: { steps: [{ text: "ready" }] },
    } } });
    expect(await requested).toEqual({ structuredContent: { steps: [{ text: "ready" }] } });
  });

  it("embeds standalone valid scripts and retains the legacy card appearance", () => {
    const resources = uiResourcesForManifest([
      { name: "browser_progress", _meta: { ui: { resourceUri: PROGRESS_CARD_URI } } },
      { name: "github_get_pull_request", _meta: { ui: { resourceUri: PULL_REQUEST_CARD_URI } } },
      { name: "browser_user_messages", _meta: { ui: { resourceUri: USER_MESSAGES_CARD_URI } } },
    ]);
    for (const resource of resources) {
      expect(resource.text).toContain("ui/initialize");
      expect(resource.text).toContain("ui/notifications/initialized");
      expect(resource.text).toContain("window.openai");
      const scripts = Array.from(resource.text.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]!);
      expect(scripts).toHaveLength(3);
      for (const script of scripts) expect(() => new Script(script)).not.toThrow();
    }
  });

  it("serves the current cards under the previous addresses while an update is under way", () => {
    const [card] = uiResourcesForManifest([
      { name: "browser_user_messages", _meta: { ui: { resourceUri: "ui://mcp-v3/user-messages-v5.html" } } },
    ]);
    expect(card!.uri).toBe("ui://mcp-v3/user-messages-v5.html");
    expect(card!.text).toContain("notifyIntrinsicHeight");
    const [legacyPlan] = uiResourcesForManifest([
      { name: "browser_progress", _meta: { ui: { resourceUri: "ui://mcp-v3/progress-v8.html" } } },
    ]);
    expect(legacyPlan!.uri).toBe("ui://mcp-v3/progress-v8.html");
    expect(legacyPlan!.text).toContain("browser_progress_read");
    expect(legacyPlan!.text).not.toContain('<textarea');
  });
});
