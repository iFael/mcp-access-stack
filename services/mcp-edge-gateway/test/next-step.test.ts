import { describe, expect, it } from "@jest/globals";
import { attachNextStep, nextStepsOf, NEXT_STEP_META_KEY } from "../src/control-plane/next-step.js";

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

describe("the next step the Edge adds to each result", () => {
  const steps = nextStepsOf([
    { name: "git_commit", _meta: { [NEXT_STEP_META_KEY]: "git_push_branch." } },
    { name: "http_get", _meta: {} },
  ]);

  it("ends a successful result with the tool's next step", async () => {
    const response = await attachNextStep(call("git_commit"),
      json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Committed." }], structuredContent: { sha: "a" } } }), steps);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {
      content: [{ type: "text", text: "Committed." }, { type: "text", text: "Next: git_push_branch." }], structuredContent: { sha: "a" } } });
  });

  it("leaves errors, other tools and other answers alone", async () => {
    const failed = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "No." }] } };
    expect(await (await attachNextStep(call("git_commit"), json(failed), steps)).json()).toEqual(failed);
    const plain = { jsonrpc: "2.0", id: 1, result: { content: [] } };
    expect(await (await attachNextStep(call("http_get"), json(plain), steps)).json()).toEqual(plain);
    const stream = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
    expect(await attachNextStep(call("git_commit"), stream, steps)).toBe(stream);
  });
});
