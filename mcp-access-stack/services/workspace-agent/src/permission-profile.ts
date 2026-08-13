import type { PermissionProfile } from "@vs-code-gpt/shared";
import { AppError } from "@vs-code-gpt/shared";

export type ReadOperation = "list" | "read" | "search" | "diff";
export type WriteOperation = "write";
export type ShellOperation = "shell";
export type WorkspaceOperation = ReadOperation | WriteOperation | ShellOperation;

const readPermissions: Readonly<Record<PermissionProfile, ReadonlySet<ReadOperation>>> = {
  "planning-readonly": new Set(["list", "read", "search", "diff"]),
  "planning-handoff": new Set(["list", "read", "search", "diff"]),
  "builder-review": new Set(["read", "diff"]),
  "restricted-area": new Set(["list", "read", "search", "diff"]),
  "full-repo-readonly": new Set(["list", "read", "search", "diff"]),
  "full-repo-write": new Set(["list", "read", "search", "diff"]),
};

const writePermissions: Readonly<Record<PermissionProfile, ReadonlySet<WriteOperation>>> = {
  "planning-readonly": new Set(),
  "planning-handoff": new Set(),
  "builder-review": new Set(),
  "restricted-area": new Set(),
  "full-repo-readonly": new Set(),
  "full-repo-write": new Set(["write"]),
};

const shellPermissions: Readonly<Record<PermissionProfile, ReadonlySet<ShellOperation>>> = {
  "planning-readonly": new Set(),
  "planning-handoff": new Set(),
  "builder-review": new Set(),
  "restricted-area": new Set(),
  "full-repo-readonly": new Set(),
  "full-repo-write": new Set(["shell"]),
};

export function assertPermission(
  profile: PermissionProfile,
  operation: WorkspaceOperation,
): void {
  const allowed =
    operation === "write"
      ? writePermissions[profile].has(operation)
      : operation === "shell"
        ? shellPermissions[profile].has(operation)
        : readPermissions[profile].has(operation);
  if (!allowed) {
    throw new AppError(
      "PERMISSION_DENIED",
      `Permission profile does not allow ${operation}.`,
    );
  }
}
