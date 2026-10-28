import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "@jest/globals";
import { z } from "zod";
import type { BrowserUserMessage } from "../src/browser-contracts.js";
import type { BrowserExecutor } from "../src/browser-executor.js";
import { registerBrowserTools, USER_MESSAGES_CARD_URI } from "../src/mcp-browser-tools.js";
import { installUserMessageDelivery } from "../src/mcp-user-messages.js";

type Handler = (...args: unknown[]) => Promise<CallToolResult>;

function call(server: McpServer, name: string, input: unknown): Promise<CallToolResult> {
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} is not registered.`);
  return tool.handler(input, {});
}

function register(server: McpServer, name: string, structuredContent: Record<string, unknown>): void {
  server.registerTool(name, {
    inputSchema: { taskId: z.string().optional(), tabId: z.string().optional(), path: z.string().optional() },
  }, async () => ({ content: [{ type: "text" as const, text: `${name} done` }], structuredContent }));
}

describe("installUserMessageDelivery", () => {
  const note: BrowserUserMessage = { id: "msg_aaaaaaaa", text: "A barra não piscou.", sentAt: "2026-10-28T15:00:00.000Z" };

  it("adds the user's popup messages to the result of any tool, scoped by the call's task or tab", async () => {
    const scopes: unknown[] = [];
    let waiting: BrowserUserMessage[] = [note];
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    installUserMessageDelivery(server, (scope) => {
      scopes.push(scope);
      const taken = waiting;
      waiting = [];
      return taken;
    });
    register(server, "read_file", {});
    register(server, "browser_open", { tab: { tabId: "personal:7", taskId: "task-1" } });

    const first = await call(server, "read_file", { path: "README.md" });
    expect(first.content).toEqual([
      { type: "text", text: "read_file done" },
      { type: "text", text: expect.stringContaining("- [2026-10-28T15:00:00.000Z] A barra não piscou.") },
    ]);
    // Delivered once: the next call carries nothing more.
    expect((await call(server, "read_file", {})).content).toHaveLength(1);
    await call(server, "browser_open", {});
    expect(scopes).toEqual([{}, {}, { taskId: "task-1", tabId: "personal:7" }]);
  });

  it("leaves the message tools themselves and Edge-to-companion operations alone", async () => {
    let takes = 0;
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    installUserMessageDelivery(server, () => {
      takes += 1;
      return [note];
    });
    register(server, "browser_user_messages", {});
    register(server, "browser_user_reply", {});
    register(server, "__mcp_v3_internal_take_user_messages", {});
    expect((await call(server, "browser_user_messages", {})).content).toHaveLength(1);
    // The reply card's own call returns to the card, never to the agent.
    expect((await call(server, "browser_user_reply", {})).content).toHaveLength(1);
    expect((await call(server, "__mcp_v3_internal_take_user_messages", {})).content).toHaveLength(1);
    expect(takes).toBe(0);
  });

  it("returns the tool's own result when taking messages fails", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    installUserMessageDelivery(server, () => {
      throw new Error("bridge gone");
    });
    register(server, "read_file", {});
    await expect(call(server, "read_file", {})).resolves.toEqual({
      content: [{ type: "text", text: "read_file done" }], structuredContent: {},
    });
  });
});

describe("browser_user_messages", () => {
  it("asks through the executor and returns the user's answer as text the agent reads", async () => {
    const inputs: unknown[] = [];
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerBrowserTools(server, {
      userMessages: async (input: unknown) => {
        inputs.push(input);
        return { asked: true, messages: [{ id: "msg_bbbbbbbb", text: "Sim, piscou uma vez.", sentAt: "2026-10-28T15:01:00.000Z", taskId: "task-1" }] };
      },
    } as unknown as BrowserExecutor, { includeTools: ["browser_user_messages"] });
    const result = await call(server, "browser_user_messages", { taskId: "task-1", question: "A barra piscou?", waitMs: 20_000 });
    expect(inputs).toEqual([{ taskId: "task-1", question: "A barra piscou?", waitMs: 20_000 }]);
    expect(result.structuredContent).toMatchObject({ asked: true, messages: [{ text: "Sim, piscou uma vez." }] });
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Sim, piscou uma vez.") }]);
  });

  it("requires a taskId for a question and an executor that reaches the popup", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerBrowserTools(server, {} as BrowserExecutor, { includeTools: ["browser_user_messages"] });
    await expect(call(server, "browser_user_messages", { question: "Tudo certo?" })).resolves.toMatchObject({ isError: true });
    await expect(call(server, "browser_user_messages", {})).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("BROWSER_CAPABILITY_UNSUPPORTED") }],
    });
  });
});

describe("the reply card in the chat", () => {
  function registered(server: McpServer, name: string): { _meta?: Record<string, unknown> } {
    return (server as unknown as { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> })._registeredTools[name]!;
  }

  it("shows the card with browser_user_messages and keeps the reply tool for the card alone", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerBrowserTools(server, {} as BrowserExecutor, { includeTools: ["browser_user_messages", "browser_user_reply", "browser_open"] });
    expect(registered(server, "browser_user_messages")._meta).toMatchObject({
      securitySchemes: [{ type: "noauth" }],
      ui: { resourceUri: USER_MESSAGES_CARD_URI },
      "openai/outputTemplate": USER_MESSAGES_CARD_URI,
      "openai/widgetAccessible": true,
    });
    expect(registered(server, "browser_user_reply")._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
    });
    expect(registered(server, "browser_open")._meta).toEqual({ securitySchemes: [{ type: "noauth" }] });
  });

  it("hands what the user typed in the card to the executor", async () => {
    const inputs: unknown[] = [];
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerBrowserTools(server, {
      postUserMessage: async (input: unknown) => {
        inputs.push(input);
        return { id: "msg_cccccccc", accepted: true };
      },
    } as unknown as BrowserExecutor, { includeTools: ["browser_user_reply"] });
    const result = await call(server, "browser_user_reply", { taskId: "task-1", text: "  Pode seguir.  " });
    expect(inputs).toEqual([{ taskId: "task-1", text: "Pode seguir." }]);
    expect(result).toMatchObject({ structuredContent: { id: "msg_cccccccc", accepted: true }, content: [{ text: "Sent to the agent." }] });
    await expect(call(server, "browser_user_reply", { text: "" })).resolves.toMatchObject({ isError: true });
  });
});
