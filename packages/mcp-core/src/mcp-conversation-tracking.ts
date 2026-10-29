import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** One tool call: which ChatGPT conversation made it and the ids it named or got back. */
export interface McpConversationCall {
  /** ChatGPT's id for the conversation (`openai/session` in the request's _meta). */
  session: string;
  tool: string;
  /** taskId, tabId, updateId and watchId values from the arguments and the result. */
  ids: string[];
}

export type OnConversationCall = (call: McpConversationCall) => void;

// Edge-to-companion operations never come from a conversation.
const INTERNAL_TOOL_PREFIX = "__mcp_v3_internal_";
const ID_KEYS = ["taskId", "tabId", "updateId", "watchId"] as const;
const SESSION_KEYS = ["openai/session", "sessionId"] as const;

/**
 * Tells which ChatGPT conversation made each tool call, so what happens later
 * for a task, tab, update or watch (a message from the reply card, a task that
 * ended) goes back to that conversation and no other. Install before any tool
 * is registered.
 */
export function installConversationTracking(server: McpServer, onCall: OnConversationCall): void {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool =
    (name: unknown, config: unknown, handler: unknown) => {
      if (typeof handler !== "function" || typeof name !== "string" || name.startsWith(INTERNAL_TOOL_PREFIX)) {
        return original(name, config, handler);
      }
      const run = handler as (...args: unknown[]) => Promise<CallToolResult>;
      return original(name, config, async (...args: unknown[]) => {
        const extra = asRecord(args.length > 1 ? args[1] : args[0]);
        const session = conversationSession(extra._meta);
        const result = await run(...args);
        if (session !== undefined) {
          const input = args.length > 1 ? args[0] : undefined;
          try {
            onCall({ session, tool: name, ids: namedIds(input, result.structuredContent) });
          } catch {
            // The call still answers; only its conversation is not remembered.
          }
        }
        return result;
      });
    };
}

export function conversationSession(meta: unknown): string | undefined {
  const record = asRecord(meta);
  for (const key of SESSION_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && value.length <= 200) return value.trim();
  }
  return undefined;
}

export function namedIds(input: unknown, structured: unknown): string[] {
  const ids = new Set<string>();
  const structuredRecord = asRecord(structured);
  for (const record of [asRecord(input), structuredRecord, asRecord(structuredRecord.tab), asRecord(structuredRecord.task)]) {
    for (const key of ID_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value && value.length <= 200) ids.add(value);
    }
  }
  return [...ids];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
