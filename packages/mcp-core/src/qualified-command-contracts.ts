import { z } from "zod";
import { shellNameSchema } from "./policy.js";

const relativeCommandPathSchema = z.string().min(1).max(4_096);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const commandExecutionModeSchema = z.enum(["direct", "qualified"]);
export type CommandExecutionMode = z.infer<typeof commandExecutionModeSchema>;

export const commandAutoCorrectionModeSchema = z.enum(["off", "safe"]);
export type CommandAutoCorrectionMode = z.infer<
  typeof commandAutoCorrectionModeSchema
>;

export const preferredCommandShellSchema = z.union([
  shellNameSchema,
  z.literal("auto"),
]);
export type PreferredCommandShell = z.infer<typeof preferredCommandShellSchema>;

export const commandEffectClassSchema = z.enum([
  "pure_read",
  "repeatable_local",
  "local_mutation",
  "external_mutation",
  "destructive",
  "unknown",
]);
export type CommandEffectClass = z.infer<typeof commandEffectClassSchema>;

export const commandRiskClassSchema = z.enum([
  "safe",
  "confirmation_required",
  "forbidden",
  "unknown",
]);
export type CommandRiskClass = z.infer<typeof commandRiskClassSchema>;

export const commandPlanSourceSchema = z.enum([
  "explicit-command",
  "deterministic-recipe",
  "provider",
]);
export type CommandPlanSource = z.infer<typeof commandPlanSourceSchema>;

export const commandDiagnosisSourceSchema = z.enum([
  "deterministic",
  "provider",
]);
export type CommandDiagnosisSource = z.infer<
  typeof commandDiagnosisSourceSchema
>;

export const commandDiagnosisCategorySchema = z.enum([
  "syntax",
  "quoting",
  "shell_incompatible",
  "executable_unavailable",
  "wrong_working_directory",
  "path_not_found",
  "argument_incompatible",
  "dependency_missing",
  "configuration_missing",
  "environment_invalid",
  "permission_denied",
  "confirmation_required",
  "resource_locked",
  "transient_failure",
  "timeout",
  "cancelled",
  "build_failed",
  "test_failed",
  "application_failed",
  "authentication_failed",
  "authorization_failed",
  "partial_completion_possible",
  "outcome_unknown",
  "unclassified",
]);
export type CommandDiagnosisCategory = z.infer<
  typeof commandDiagnosisCategorySchema
>;

export const commandExpectedOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exit_code"),
      value: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file_exists"),
      path: relativeCommandPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("file_absent"),
      path: relativeCommandPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sha256"),
      path: relativeCommandPathSchema,
      value: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text_contains"),
      stream: z.enum(["stdout", "stderr"]),
      value: z.string().min(1).max(4_096),
    })
    .strict(),
  z
    .object({
      kind: z.literal("json_field"),
      path: relativeCommandPathSchema,
      pointer: z.string().min(1).max(1_024),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("git_clean"),
      root: relativeCommandPathSchema.default("."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("process_exited"),
      pid: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("http_status"),
      url: z.url(),
      value: z.number().int().min(100).max(599),
    })
    .strict(),
  z
    .object({
      kind: z.literal("duration_lte"),
      valueMs: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type CommandExpectedOutcome = z.infer<
  typeof commandExpectedOutcomeSchema
>;

export const commandPostconditionSchema = commandExpectedOutcomeSchema;
export type CommandPostcondition = z.infer<typeof commandPostconditionSchema>;

export const commandPlanExecutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("argv"),
      executable: z.string().min(1).max(4_096),
      argv: z.array(z.string().max(32_000)).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("script"),
      script: z.string().min(1).max(32_000),
    })
    .strict(),
]);
export type CommandPlanExecution = z.infer<typeof commandPlanExecutionSchema>;

export const commandPlanProvenanceSchema = z
  .object({
    source: commandPlanSourceSchema,
    recipeId: z.string().min(1).max(256).optional(),
    provider: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(128).optional(),
    sanitized: z.boolean(),
  })
  .strict();
export type CommandPlanProvenance = z.infer<
  typeof commandPlanProvenanceSchema
>;

export const commandPlanSchema = z
  .object({
    invocationId: z.string().min(1).max(128),
    objective: z.string().min(1).max(4_000).optional(),
    source: commandPlanSourceSchema,
    shell: shellNameSchema,
    cwd: relativeCommandPathSchema,
    execution: commandPlanExecutionSchema,
    timeoutMs: z.number().int().positive().max(86_400_000),
    absoluteDeadline: z.iso.datetime(),
    riskClass: commandRiskClassSchema,
    effectClass: commandEffectClassSchema,
    expectedOutcomes: z.array(commandExpectedOutcomeSchema).max(20),
    postconditions: z.array(commandPostconditionSchema).max(20),
    fingerprint: sha256Schema,
    provenance: commandPlanProvenanceSchema,
  })
  .strict();
export type CommandPlan = z.infer<typeof commandPlanSchema>;

export const commandDiagnosisSchema = z
  .object({
    category: commandDiagnosisCategorySchema,
    confidence: z.number().min(0).max(1),
    source: commandDiagnosisSourceSchema,
    message: z.string().min(1).max(1_000).optional(),
  })
  .strict();
export type CommandDiagnosis = z.infer<typeof commandDiagnosisSchema>;

export const commandCorrectionSchema = z
  .object({
    applied: z.boolean(),
    effectiveCommand: z.string().min(1).max(32_000).optional(),
    effectiveShell: shellNameSchema.optional(),
    effectiveCwd: relativeCommandPathSchema.optional(),
    sanitized: z.boolean(),
    blockedReason: z.string().min(1).max(1_000).optional(),
  })
  .strict();
export type CommandCorrection = z.infer<typeof commandCorrectionSchema>;

export const commandPostconditionResultSchema = z
  .object({
    passed: z.boolean(),
    checked: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export type CommandPostconditionResult = z.infer<
  typeof commandPostconditionResultSchema
>;

export const commandAttemptSchema = z
  .object({
    attempt: z.number().int().min(1).max(2),
    planFingerprint: sha256Schema,
    shell: shellNameSchema,
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
  })
  .strict();
export type CommandAttempt = z.infer<typeof commandAttemptSchema>;

export const qualifiedCommandFeatureFlagsSchema = z
  .object({
    qualifiedExecution: z.boolean(),
    safeAutoCorrection: z.boolean(),
    shadowMode: z.boolean().optional(),
    providerEnabled: z.boolean().optional(),
  })
  .strict();
export type QualifiedCommandFeatureFlags = z.infer<
  typeof qualifiedCommandFeatureFlagsSchema
>;

export const disabledQualifiedCommandFeatureFlags = Object.freeze({
  qualifiedExecution: false,
  safeAutoCorrection: false,
  shadowMode: false,
  providerEnabled: false,
}) satisfies QualifiedCommandFeatureFlags;
