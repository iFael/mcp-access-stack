import { describe, expect, it } from "@jest/globals";
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
    expect(resources[0]!.text).toContain("veja abaixo");
    expect(resources[0]!.text).not.toContain('id="pin"');
    expect(resources[1]!.text).toContain("Abrir no GitHub");
    for (const resource of resources) {
      expect(resource.text).toContain("requestDisplayMode");
      expect(resource.text).not.toContain("${");
    }
  });

  it("tells in the reply card whether the agent has each message yet", () => {
    const [card] = uiResourcesForManifest([{ name: "browser_user_messages", _meta: { ui: { resourceUri: USER_MESSAGES_CARD_URI } } }]);
    expect(card!.uri).toBe("ui://mcp-v3/user-messages-v4.html");
    expect(card!.text).toContain("Entregue ao agente às");
    expect(card!.text).toContain("Ainda não entregue");
    // It asks again with the same id, which never sends the message twice.
    expect(card!.text).toContain("structured.delivered === true");
    expect(card!.text).not.toContain("${");
  });
});
