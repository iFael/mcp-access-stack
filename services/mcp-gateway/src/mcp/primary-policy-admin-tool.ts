import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError, asAppError } from "@vs-code-gpt/shared";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const grantInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect") }).strict(),
  z.object({
    action: z.literal("grant"),
    expectedPolicySha256: sha256Schema,
    operationId: z.string().uuid(),
  }).strict(),
]);

const grantResultSchema = z.object({
  status: z.enum(["not_granted", "granted", "already_granted"]),
  workspaceId: z.literal("mcp-access-stack"),
  capability: z.literal("github.pull_request.ready"),
  policySha256: sha256Schema,
  effective: z.boolean(),
  backupCreated: z.boolean(),
}).strict();

export type PrimaryPolicyGrantResult = z.infer<typeof grantResultSchema>;
export type PrimaryPolicyGrantInput = z.infer<typeof grantInputSchema>;

export interface PrimaryPolicyAdmin {
  inspect(): Promise<PrimaryPolicyGrantResult>;
  grant(input: { expectedPolicySha256: string; operationId: string; actor: string }):
    Promise<PrimaryPolicyGrantResult>;
}

export function registerPrimaryPolicyAdminTool(
  server: McpServer,
  admin?: PrimaryPolicyAdmin,
  authenticatedUserId?: string,
  securitySchemes: Array<{ type: "oauth2" | "noauth"; scopes?: string[] }> = [{ type: "noauth" }],
): void {
  server.registerTool(
    "oracle_grant_github_ready_permission",
    {
      title: "Inspect or grant Oracle GitHub ready-for-review permission",
      description: "Oracle-only administrative operation. Inspects the installed policy or grants only github.pull_request.ready to mcp-access-stack using policy SHA-256 CAS, a UUID operation ID, backup, audit and in-process policy reload. No arbitrary file paths or capabilities.",
      inputSchema: grantInputSchema,
      outputSchema: grantResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: { securitySchemes },
    },
    async (input) => {
      try {
        if (!admin || !authenticatedUserId?.trim()) {
          throw new AppError("PERMISSION_DENIED", "Oracle policy administration requires a trusted authenticated owner session.");
        }
        const parsed = grantInputSchema.parse(input);
        const result = grantResultSchema.parse(parsed.action === "inspect"
          ? await admin.inspect()
          : await admin.grant({ expectedPolicySha256: parsed.expectedPolicySha256,
              operationId: parsed.operationId, actor: authenticatedUserId }));
        return {
          content: [{ type: "text" as const, text: `Oracle policy: ${result.status}, effective=${result.effective}.` }],
          structuredContent: result,
        };
      } catch (error) {
        const safe = asAppError(error);
        return { isError: true, content: [{ type: "text" as const, text: `${safe.code}: ${safe.message}` }] };
      }
    },
  );
}
