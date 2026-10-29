import { describe, expect, it } from "@jest/globals";
import { ProgressPlans, PROGRESS_CARD_URI } from "../src/control-plane/progress-card.js";
import { PULL_REQUEST_CARD_URI } from "../src/control-plane/pull-request-card.js";
import { uiResourcesForManifest } from "../src/control-plane/user-messages-card.js";

function call(name: string, args: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function result(response: Response | null) {
  expect(response).not.toBeNull();
  return (await response!.json() as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }).result;
}

function memory() {
  const values = new Map<string, unknown>();
  return { get: async <T>(key: string) => values.get(key) as T | undefined, put: async <T>(key: string, value: T) => { values.set(key, value); } };
}

describe("the plan card", () => {
  const steps = [{ text: "Ler o código", state: "done" }, { text: "Corrigir", state: "doing" }, { text: "Publicar", state: "todo" }];

  it("opens one plan, changes it in place and lets the card read the latest", async () => {
    let ids = 0;
    const plans = new ProgressPlans(memory(), () => new Date("2026-10-29T02:00:00.000Z"),
      () => `plan_00000000-0000-4000-8000-00000000000${++ids}`);
    const opened = await result(await plans.handle(call("browser_progress", { title: "Corrigir o CI", steps, deviceId: "dev_x" }), "user_1"));
    expect(opened.structuredContent).toEqual({ planId: "plan_00000000-0000-4000-8000-000000000001", title: "Corrigir o CI", steps,
      updatedAt: "2026-10-29T02:00:00.000Z" });
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
    expect(resources[1]!.text).toContain("Abrir no GitHub");
    for (const resource of resources) {
      expect(resource.text).toContain("requestDisplayMode");
      expect(resource.text).not.toContain("${");
    }
  });
});
