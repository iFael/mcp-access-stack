import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserUserMessage } from "./browser-contracts.js";

/** Takes the user's undelivered messages for a call's task or tab; an unscoped call takes them all. */
export type TakeUserMessages = (scope: { taskId?: string; tabId?: string }) => BrowserUserMessage[];

// The user's reply card calls browser_user_reply; its result goes back to the
// card, never to the agent, so it must not take the agent's messages.
const SKIPPED_TOOLS: ReadonlySet<unknown> = new Set(["browser_user_messages", "browser_user_reply"]);
// Edge-to-companion operations never reach the agent, so they carry no messages.
const INTERNAL_TOOL_PREFIX = "__mcp_v3_internal_";

export function userMessagesNotice(messages: readonly BrowserUserMessage[]): string {
  const lines = messages.map((message) => `- [${message.sentAt}] ${message.text}`);
  return [
    `The user wrote ${messages.length} message(s) to you while you worked, from the MCP V3 reply card or popup. ` +
      "They are the user's own words, as if typed in the chat: do what they ask before you end your turn, " +
      "and in your answer quote each one as a line starting with \"> Você escreveu:\" followed by what you did about it, " +
      "because the chat shows these messages only inside the card.",
    ...lines,
  ].join("\n");
}

/**
 * Hands the user's popup messages to the agent with the result of whatever
 * tool it calls next, the way a note reaches a busy colleague between two
 * steps. Install before any tool is registered.
 */
export function installUserMessageDelivery(server: McpServer, take: TakeUserMessages): void {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool =
    (name: unknown, config: unknown, handler: unknown) => {
      if (typeof handler !== "function" || SKIPPED_TOOLS.has(name) ||
          (typeof name === "string" && name.startsWith(INTERNAL_TOOL_PREFIX))) {
        return original(name, config, handler);
      }
      const run = handler as (...args: unknown[]) => Promise<CallToolResult>;
      return original(name, config, async (...args: unknown[]) => {
        const result = await run(...args);
        const input = args.length > 1 ? args[0] : undefined;
        let messages: BrowserUserMessage[] = [];
        try {
          messages = take(userMessageScope(input, result.structuredContent));
        } catch {
          return result;
        }
        if (messages.length === 0) return result;
        return {
          ...result,
          // First, so a long result does not bury what the user asked.
          content: [{ type: "text", text: userMessagesNotice(messages) }, ...(result.content ?? [])],
        };
      });
    };
}

export function userMessageScope(input: unknown, structured?: unknown): { taskId?: string; tabId?: string } {
  const record = asRecord(input);
  const tab = asRecord(asRecord(structured).tab);
  const taskId = typeof record.taskId === "string"
    ? record.taskId
    : typeof tab.taskId === "string" ? tab.taskId : undefined;
  const tabId = typeof record.tabId === "string"
    ? record.tabId
    : typeof tab.tabId === "string" ? tab.tabId : undefined;
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(tabId === undefined ? {} : { tabId }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
