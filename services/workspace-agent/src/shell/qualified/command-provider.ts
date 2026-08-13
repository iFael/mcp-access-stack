import { createHash } from "node:crypto";
import {
  redactSensitiveText,
  shellNameSchema,
  type CommandDiagnosis,
  type CommandPlan,
  type QualifiedRunCommandInput,
  type ShellName,
} from "@vs-code-gpt/shared";
import { z } from "zod";
import type { LimitedCommandContext } from "./types.js";

const providerNoProposalSchema = z.object({
  status: z.literal("none"),
}).strict();

export const providerCommandProposalSchema = z.discriminatedUnion("status", [
  providerNoProposalSchema,
  z
    .object({
      status: z.literal("proposal"),
      command: z.string().min(1).max(32_000),
      shell: shellNameSchema,
      cwd: z.string().min(1).max(4_096).optional(),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1).max(1_000).optional(),
    })
    .strict(),
]);
export type ProviderCommandProposal = z.infer<
  typeof providerCommandProposalSchema
>;

export const providerRepairProposalSchema = z.discriminatedUnion("status", [
  providerNoProposalSchema,
  z
    .object({
      status: z.literal("proposal"),
      action: z.literal("retry_same"),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1).max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("proposal"),
      action: z.literal("change_shell"),
      shell: shellNameSchema,
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1).max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("proposal"),
      action: z.literal("change_cwd_root"),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1).max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("proposal"),
      action: z.literal("replace_executable"),
      executable: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[a-z0-9._+-]+$/iu),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1).max(1_000).optional(),
    })
    .strict(),
]);
export type ProviderRepairProposal = z.infer<
  typeof providerRepairProposalSchema
>;

export interface CommandProviderIdentity {
  name: string;
  model: string;
}

export interface SanitizedCommandProviderContext {
  platform: NodeJS.Platform;
  architecture: string;
  logicalCwd: string;
  allowedShells: ShellName[];
  markers: Array<{
    path: string;
    kind: string;
    sizeBytes?: number;
    sha256?: string;
  }>;
  packageManager?: string;
  packageScripts: Array<{
    name: string;
    commandSha256: string;
    effectClass: string;
    riskClass: string;
  }>;
  gitRepository: boolean;
  tools: Array<{
    name: string;
    available: boolean;
    version?: string;
  }>;
}

export interface PlannerProviderInput {
  objective: string;
  preferredShell: ShellName | "auto";
  context: SanitizedCommandProviderContext;
}

export interface ProviderArgumentShape {
  index: number;
  kind: "option" | "opaque";
  value?: string;
  sha256?: string;
  length: number;
}

export interface RepairProviderInput {
  objective?: string;
  diagnosis: Pick<CommandDiagnosis, "category" | "confidence" | "source"> & {
    message?: string;
  };
  plan: {
    source: CommandPlan["source"];
    shell: ShellName;
    cwd: string;
    executable: string;
    arguments: ProviderArgumentShape[];
    effectClass: CommandPlan["effectClass"];
    riskClass: CommandPlan["riskClass"];
  };
  context: SanitizedCommandProviderContext;
}

export interface RecipeOptimizerProviderInput {
  objective: string;
  successfulPlan: {
    shell: ShellName;
    cwd: string;
    executable: string;
    arguments: ProviderArgumentShape[];
    effectClass: CommandPlan["effectClass"];
    riskClass: CommandPlan["riskClass"];
  };
  context: SanitizedCommandProviderContext;
}

export interface PlannerProvider {
  readonly identity: CommandProviderIdentity;
  plan(
    input: PlannerProviderInput,
    signal?: AbortSignal,
  ): Promise<ProviderCommandProposal>;
}

export interface RepairProvider {
  readonly identity: CommandProviderIdentity;
  repair(
    input: RepairProviderInput,
    signal?: AbortSignal,
  ): Promise<ProviderRepairProposal>;
}

export interface RecipeOptimizerProvider {
  readonly identity: CommandProviderIdentity;
  optimize(
    input: RecipeOptimizerProviderInput,
    signal?: AbortSignal,
  ): Promise<ProviderCommandProposal>;
}

export interface QualifiedCommandProvider
  extends PlannerProvider,
    RepairProvider,
    RecipeOptimizerProvider {}

export function sanitizedProviderContext(
  context: LimitedCommandContext,
): SanitizedCommandProviderContext {
  return {
    platform: context.platform,
    architecture: context.architecture,
    logicalCwd: context.logicalCwd,
    allowedShells: [...context.allowedShells],
    markers: context.markers.map((marker) => ({
      path: marker.path,
      kind: marker.kind,
      ...(marker.sizeBytes === undefined
        ? {}
        : { sizeBytes: marker.sizeBytes }),
      ...(marker.sha256 === undefined ? {} : { sha256: marker.sha256 }),
    })),
    ...(context.packageMetadata?.packageManager === undefined
      ? {}
      : { packageManager: context.packageMetadata.packageManager }),
    packageScripts:
      context.packageMetadata?.scripts.map((script) => ({
        name: script.name,
        commandSha256: script.commandSha256,
        effectClass: script.effectClass,
        riskClass: script.riskClass,
      })) ?? [],
    gitRepository: context.git.repository,
    tools: context.tools.map((tool) => ({
      name: tool.name,
      available: tool.available,
      ...(tool.version === undefined ? {} : { version: tool.version }),
    })),
  };
}

export function plannerProviderInput(
  input: QualifiedRunCommandInput,
  context: LimitedCommandContext,
): PlannerProviderInput | undefined {
  if (!input.objective) return undefined;
  return {
    objective: sanitizeProviderText(input.objective, 4_000),
    preferredShell:
      input.shell ?? input.preferredShell ?? "auto",
    context: sanitizedProviderContext(context),
  };
}

export function repairProviderInput(
  plan: CommandPlan,
  diagnosis: CommandDiagnosis,
  context: LimitedCommandContext,
): RepairProviderInput | undefined {
  if (plan.execution.kind !== "argv") return undefined;
  return {
    ...(plan.objective === undefined
      ? {}
      : { objective: sanitizeProviderText(plan.objective, 4_000) }),
    diagnosis: {
      category: diagnosis.category,
      confidence: diagnosis.confidence,
      source: diagnosis.source,
      ...(diagnosis.message === undefined
        ? {}
        : { message: sanitizeProviderText(diagnosis.message, 1_000) }),
    },
    plan: {
      source: plan.source,
      shell: plan.shell,
      cwd: plan.cwd,
      executable: sanitizeExecutable(plan.execution.executable),
      arguments: plan.execution.argv.map(argumentShape),
      effectClass: plan.effectClass,
      riskClass: plan.riskClass,
    },
    context: sanitizedProviderContext(context),
  };
}

export function applyPlannerProposal(
  input: QualifiedRunCommandInput,
  proposal: Extract<ProviderCommandProposal, { status: "proposal" }>,
): QualifiedRunCommandInput {
  const {
    confirmationId: _confirmationId,
    command: _command,
    shell: _shell,
    cwd: _cwd,
    preferredShell: _preferredShell,
    ...base
  } = input;
  return {
    ...base,
    command: proposal.command,
    shell: proposal.shell,
    ...(proposal.cwd === undefined ? {} : { cwd: proposal.cwd }),
  };
}

export function sanitizeProviderText(value: string, maximum: number): string {
  return redactSensitiveText(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function argumentShape(value: string, index: number): ProviderArgumentShape {
  if (/^--?[a-z0-9][a-z0-9._-]*(?:=[a-z0-9._-]+)?$/iu.test(value)) {
    return {
      index,
      kind: "option",
      value: value.slice(0, 256),
      length: value.length,
    };
  }
  return {
    index,
    kind: "opaque",
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    length: value.length,
  };
}

function sanitizeExecutable(value: string): string {
  const normalized = value.trim().slice(0, 256);
  return /^[a-z0-9._+-]+$/iu.test(normalized)
    ? normalized
    : createHash("sha256").update(normalized, "utf8").digest("hex");
}
