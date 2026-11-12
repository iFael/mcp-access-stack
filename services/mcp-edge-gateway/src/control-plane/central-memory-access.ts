import type { RepositoryRole } from "./account-store.js";

export type MemoryAccessDenial =
  | "IDENTITY_REQUIRED"
  | "MEMORY_ROUTE_INVALID"
  | "REPOSITORY_NOT_FOUND"
  | "PERMISSION_DENIED";

type MembershipLookup = (userId: string, repositoryId: string) =>
  Promise<{ role: RepositoryRole; repository?: {normalizedName:string} } | null>;

/** The Edge validates repository membership before any memory call reaches Oracle. */
export async function authorizeCentralMemory(
  action: "memory_context" | "memory_update" | "memory_recovery_export",
  args: Record<string, unknown>,
  userId: string | undefined,
  membership: MembershipLookup,
): Promise<MemoryAccessDenial | null> {
  if (!userId) return "IDENTITY_REQUIRED";
  if (args.workspaceId !== "mcp-access-stack") return "MEMORY_ROUTE_INVALID";
  const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
  if (!repositoryId) return "REPOSITORY_NOT_FOUND";
  const access = await membership(userId,repositoryId);
  if (!access) return "REPOSITORY_NOT_FOUND";
  if (action === "memory_recovery_export" && access.role !== "owner") return "PERMISSION_DENIED";
  if (action === "memory_update" && access.role === "viewer") return "PERMISSION_DENIED";
  if (action === "memory_update" && args.action === "activate_legacy" &&
      access.role !== "owner") return "PERMISSION_DENIED";
  // The historical .codex import is only for the MCP V3 repo. Do not let an
  // unrelated project bind itself as the system-memory source of truth.
  if (action === "memory_update" &&
      (args.action === "import_legacy" || args.action === "activate_legacy") &&
      access.repository?.normalizedName !== "mcp-access-stack") return "PERMISSION_DENIED";
  return null;
}
