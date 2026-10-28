import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { COMPANION_INTERNAL_TAKE_USER_MESSAGES_TOOL } from "@mcp-access-stack/edge-protocol";
import { userMessagesNotice, type TakeUserMessages } from "@vs-code-gpt/shared";
import { z } from "zod";

const takeUserMessagesInputSchema = z.object({
  taskId: z.string().min(1).max(128).optional(),
  tabId: z.string().min(1).max(128).optional(),
}).strict();

const takeUserMessagesResultSchema = z.object({
  count: z.number().int().nonnegative(),
  notice: z.string().min(1).optional(),
}).strict();

// The Edge asks for the user's popup messages after a call it relayed to
// another runtime, and appends the notice to that call's result.
export function registerCompanionInternalUserMessageTools(
  server: McpServer,
  take: TakeUserMessages,
): void {
  server.registerTool(
    COMPANION_INTERNAL_TAKE_USER_MESSAGES_TOOL,
    {
      title: "MCP V3 internal user messages",
      description: "Internal Edge-to-companion delivery of the user's popup messages.",
      inputSchema: takeUserMessagesInputSchema,
      outputSchema: takeUserMessagesResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const messages = take({
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
      });
      const structuredContent = takeUserMessagesResultSchema.parse({
        count: messages.length,
        ...(messages.length === 0 ? {} : { notice: userMessagesNotice(messages) }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );
}
