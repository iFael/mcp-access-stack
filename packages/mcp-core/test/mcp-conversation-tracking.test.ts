import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "@jest/globals";
import { z } from "zod";
import { installConversationTracking, MCP_MEMORY_CHECKPOINT_META_KEY, type McpConversationCall } from "../src/mcp-conversation-tracking.js";

type Handler = (...args: unknown[]) => Promise<CallToolResult>;

function call(server: McpServer, name: string, input: unknown, meta?: Record<string, unknown>): Promise<CallToolResult> {
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} is not registered.`);
  return tool.handler(input, meta === undefined ? {} : { _meta: meta });
}

describe("installConversationTracking", () => {
  it("observes completed typed results without requiring a session or exposing inputs",async()=>{
    const observed:string[]=[];
    const server=new McpServer({name:"test",version:"0.0.0"},{capabilities:{tools:{}}});
    installConversationTracking(server,undefined,async entry=>{
      observed.push(entry.tool);
      return entry.tool==="mcp_update"
        ? {recordId:"mcp-update:known",revision:1}
        : null;
    });
    server.registerTool("mcp_update",{inputSchema:{action:z.string()}},
      async()=>({content:[{type:"text" as const,text:"completed"}],
        structuredContent:{update:{status:"succeeded"}}}));
    server.registerTool("get_release_state",{inputSchema:{}},
      async()=>({content:[{type:"text" as const,text:"ok"}],
        structuredContent:{state:{active:{releaseId:"beta"}}}}));
    const first=await call(server,"mcp_update",{action:"read"});
    expect(first._meta?.[MCP_MEMORY_CHECKPOINT_META_KEY]).toEqual({
      recordId:"mcp-update:known",revision:1,
    });
    const second=await call(server,"get_release_state",{});
    expect(second._meta).toBeUndefined();
    expect(observed).toEqual(["mcp_update","get_release_state"]);
  });
  it("does not turn a successful release into a tool failure if memory capture fails",async()=>{
    const server=new McpServer({name:"test",version:"0.0.0"},{capabilities:{tools:{}}});
    installConversationTracking(server,undefined,async()=>{
      throw new Error("memory-unavailable");
    });
    server.registerTool("mcp_update",{inputSchema:{}},
      async()=>({content:[{type:"text" as const,text:"completed"}],
        structuredContent:{update:{status:"succeeded"}}}));
    const result=await call(server,"mcp_update",{});
    expect(result.isError).not.toBe(true);
    expect(result._meta?.["io.github.ifael/mcp-memory-warning"]).toBe("checkpoint_deferred");
  });

  it("reports the ChatGPT conversation of each call with the ids it named or got back", async () => {
    const calls: McpConversationCall[] = [];
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    installConversationTracking(server, (entry) => calls.push(entry));
    server.registerTool("start_background_task", { inputSchema: { command: z.string() } },
      async () => ({ content: [{ type: "text" as const, text: "started" }], structuredContent: { task: { taskId: "task-9" } } }));
    server.registerTool("browser_user_messages", { inputSchema: { taskId: z.string() } },
      async () => ({ content: [{ type: "text" as const, text: "[]" }], structuredContent: { messages: [] } }));
    server.registerTool("__mcp_v3_internal_take", { inputSchema: { taskId: z.string() } },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }));

    await call(server, "start_background_task", { command: "x" }, { "openai/session": "session-1" });
    await call(server, "browser_user_messages", { taskId: "task-1" }, { "openai/session": "session-1" });
    await call(server, "browser_user_messages", { taskId: "task-2" });
    await call(server, "__mcp_v3_internal_take", { taskId: "task-3" }, { "openai/session": "session-1" });

    expect(calls).toEqual([
      { session: "session-1", tool: "start_background_task", ids: ["task-9"] },
      { session: "session-1", tool: "browser_user_messages", ids: ["task-1"] },
    ]);
  });
});
