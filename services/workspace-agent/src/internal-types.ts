import type {
  ConfirmationMode,
  PermissionProfile,
  ShellName,
  WorkspaceKind,
  WorkspaceLimits,
} from "@vs-code-gpt/shared";

export interface ResolvedAllowedRoot {
  logicalPath: string;
  absolutePath: string;
  canonicalPath: string;
  kind: "file" | "directory";
}

export interface ResolvedWorkspace {
  id: string;
  name: string;
  rootPath: string;
  workspaceKind?: WorkspaceKind;
  canonicalRootPath: string;
  enabled: boolean;
  permissionProfile: PermissionProfile;
  confirmationMode: ConfirmationMode;
  allowedRoots: ResolvedAllowedRoot[];
  blockedGlobs: string[];
  limits: WorkspaceLimits;
  allowWrites: string[];
  allowShell: string[];
  allowedShells: ShellName[];
}

export interface AuthorizedPath {
  logicalPath: string;
  absolutePath: string;
  canonicalPath: string;
  canonicalRelativePath: string;
  kind: "file" | "directory";
}

export interface AuthorizedWritePath {
  logicalPath: string;
  absolutePath: string;
  created: boolean;
}
