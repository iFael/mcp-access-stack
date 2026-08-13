import type {
  CommandEffectClass,
  CommandPlan,
  CommandPlanExecution,
  CommandRiskClass,
  QualifiedRunCommandInput,
  ShellName,
} from "@vs-code-gpt/shared";

export interface LimitedWorkspaceMarker {
  path: string;
  kind:
    | "package-manifest"
    | "package-lock"
    | "project-manifest"
    | "instruction"
    | "repository";
  sizeBytes?: number;
  sha256?: string;
}

export interface LimitedPackageScriptMetadata {
  name: string;
  commandSha256: string;
  effectClass: CommandEffectClass;
  riskClass: CommandRiskClass;
}

export interface LimitedPackageMetadata {
  name?: string;
  packageManager?: string;
  scripts: LimitedPackageScriptMetadata[];
}

export interface LimitedGitContext {
  repository: boolean;
  branch?: string;
  dirty?: boolean;
}

export interface LimitedToolContext {
  name: string;
  available: boolean;
  version?: string;
}

export interface LimitedCommandContext {
  workspaceId: string;
  logicalCwd: string;
  absoluteCwd: string;
  platform: NodeJS.Platform;
  architecture: string;
  allowedShells: ShellName[];
  markers: LimitedWorkspaceMarker[];
  packageMetadata?: LimitedPackageMetadata;
  git: LimitedGitContext;
  tools: LimitedToolContext[];
}

export interface ShellSyntaxDiagnostic {
  code: "syntax_error" | "unsupported_construct" | "shell_unavailable";
  message: string;
}

export interface ShellCommandAnalysis {
  shell: ShellName;
  valid: boolean;
  execution?: CommandPlanExecution;
  diagnostics: ShellSyntaxDiagnostic[];
  usesShellFeatures: boolean;
}

export interface CommandClassification {
  effectClass: CommandEffectClass;
  riskClass: CommandRiskClass;
  reasons: string[];
}

export interface DeterministicCommandRecipe {
  id: string;
  description: string;
  intent: "test" | "build" | "lint" | "typecheck" | "check" | "git-status";
  shell: ShellName | "auto";
  execution: CommandPlanExecution;
  requiredTools: string[];
  requiredMarkers: string[];
  classification: CommandClassification;
  defaultPostconditionExitCode: number;
}

export interface CommandQualificationIssue {
  code:
    | "WORKSPACE_MISMATCH"
    | "NO_ALLOWED_SHELL"
    | "SHELL_CONFLICT"
    | "SHELL_NOT_ALLOWED"
    | "INVALID_COMMAND_SYNTAX"
    | "NO_DETERMINISTIC_RECIPE"
    | "AMBIGUOUS_DETERMINISTIC_RECIPE"
    | "REQUIRED_TOOL_UNAVAILABLE"
    | "REQUIRED_MARKER_MISSING"
    | "INVALID_POSTCONDITION"
    | "UNQUALIFIABLE_EFFECT";
  message: string;
}

export type CommandQualificationResult =
  | {
      status: "qualified";
      plan: CommandPlan;
      context: LimitedCommandContext;
      recipeId?: string;
    }
  | {
      status: "blocked";
      issues: CommandQualificationIssue[];
      context: LimitedCommandContext;
    };

export interface QualifiedCommandQualificationRequest {
  invocationId: string;
  input: QualifiedRunCommandInput;
  workspaceId: string;
  now?: Date;
  absoluteDeadline?: string;
  signal?: AbortSignal;
}
