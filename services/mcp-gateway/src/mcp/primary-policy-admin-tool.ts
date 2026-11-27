import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError, asAppError, ORACLE_EDITOR_DEPENDENCY_GRANT, ORACLE_EDITOR_DEPENDENCY_ROOT } from "@vs-code-gpt/shared";
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

type GrantCapability = "github.pull_request.ready" | "git.worktree.write" | typeof ORACLE_EDITOR_DEPENDENCY_GRANT;
const grantResultSchema = <C extends GrantCapability>(capability: C) => z.object({
  status: z.enum(["not_granted", "granted", "already_granted"]),
  workspaceId: z.literal("mcp-access-stack"),
  capability: z.literal(capability),
  policySha256: sha256Schema,
  effective: z.boolean(),
  backupCreated: z.boolean(),
}).strict();

export type PrimaryPolicyGrantResult = z.infer<ReturnType<typeof readyGrantResultSchema>>;
export type PrimaryPolicyGrantInput = z.infer<typeof grantInputSchema>;
export type WorktreePolicyGrantResult = z.infer<ReturnType<typeof worktreeGrantResultSchema>>;

function readyGrantResultSchema() {
  return grantResultSchema("github.pull_request.ready");
}
function worktreeGrantResultSchema() {
  return grantResultSchema("git.worktree.write");
}

interface NarrowPolicyAdmin<C extends GrantCapability> {
  inspect(): Promise<z.infer<ReturnType<typeof grantResultSchema<C>>>>;
  grant(input: { expectedPolicySha256: string; operationId: string; actor: string }):
    Promise<z.infer<ReturnType<typeof grantResultSchema<C>>>>;
}

export type PrimaryPolicyAdmin = NarrowPolicyAdmin<"github.pull_request.ready">;
export type WorktreePolicyAdmin = NarrowPolicyAdmin<"git.worktree.write">;
export type DependencyInstallPolicyAdmin = NarrowPolicyAdmin<typeof ORACLE_EDITOR_DEPENDENCY_GRANT>;

function registerNarrowPolicyAdminTool<C extends GrantCapability>(
  server: McpServer,
  name: "oracle_grant_github_ready_permission" | "oracle_grant_worktree_permission" | "oracle_grant_dependency_install_permission",
  capability: C,
  admin: NarrowPolicyAdmin<C> | undefined,
  authenticatedUserId: string | undefined,
  securitySchemes: Array<{ type: "oauth2" | "noauth"; scopes?: string[] }>,
): void {
  server.registerTool(
    name,
    {
      title: capability === ORACLE_EDITOR_DEPENDENCY_GRANT ? "Inspect or grant Oracle editor fixture dependency permission" : capability === "git.worktree.write"
        ? "Inspect or grant Oracle Git worktree permission"
        : "Inspect or grant Oracle GitHub ready-for-review permission",
      description: capability === ORACLE_EDITOR_DEPENDENCY_GRANT
        ? `Oracle owner-only fixed opt-in for ${ORACLE_EDITOR_DEPENDENCY_ROOT} in mcp-access-stack. Inspect first, then grant with policy SHA-256 CAS and operationId. Preserves existing permissions; backup, audit and in-process reload. Cannot choose a path or grant arbitrary shell execution.`
        : capability === "git.worktree.write"
        ? "Oracle-only fixed git.worktree.write grant for mcp-access-stack: inspect first, then grant with policy SHA-256 CAS and operationId. Audits, backs up and reloads the policy in-process; cannot choose paths or other capabilities."
        : "Oracle-only administrative operation. Inspects the installed policy or grants only github.pull_request.ready to mcp-access-stack using policy SHA-256 CAS, a UUID operation ID, backup, audit and in-process policy reload. No arbitrary file paths or capabilities.",
      inputSchema: grantInputSchema,
      outputSchema: grantResultSchema(capability),
      annotations: {
        readOnlyHint: false,
        destructiveHint: capability !== "github.pull_request.ready",
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
        const result = grantResultSchema(capability).parse(parsed.action === "inspect"
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

export function registerPrimaryPolicyAdminTool(
  server: McpServer,
  admin?: PrimaryPolicyAdmin,
  authenticatedUserId?: string,
  securitySchemes: Array<{ type: "oauth2" | "noauth"; scopes?: string[] }> = [{ type: "noauth" }],
): void {
  registerNarrowPolicyAdminTool(server, "oracle_grant_github_ready_permission",
    "github.pull_request.ready", admin, authenticatedUserId, securitySchemes);
}

export function registerWorktreePolicyAdminTool(
  server: McpServer,
  admin?: WorktreePolicyAdmin,
  authenticatedUserId?: string,
  securitySchemes: Array<{ type: "oauth2" | "noauth"; scopes?: string[] }> = [{ type: "noauth" }],
): void {
  registerNarrowPolicyAdminTool(server, "oracle_grant_worktree_permission",
    "git.worktree.write", admin, authenticatedUserId, securitySchemes);
}

export function registerDependencyInstallPolicyAdminTool(
  server: McpServer,
  admin?: DependencyInstallPolicyAdmin,
  authenticatedUserId?: string,
  securitySchemes: Array<{ type: "oauth2" | "noauth"; scopes?: string[] }> = [{ type: "noauth" }],
): void {
  registerNarrowPolicyAdminTool(server, "oracle_grant_dependency_install_permission",
    ORACLE_EDITOR_DEPENDENCY_GRANT, admin, authenticatedUserId, securitySchemes);
}
