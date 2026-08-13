import { z } from "zod";
import {
  runCommandResultSchema,
  serializedErrorSchema,
} from "./contracts.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const commandInvocationStates = [
  "received",
  "qualified",
  "awaiting_confirmation",
  "executing",
  "diagnosed",
  "repaired",
  "completed",
  "blocked",
  "outcome_unknown",
] as const;

export const commandInvocationStateSchema = z.enum(commandInvocationStates);
export type CommandInvocationState = z.infer<
  typeof commandInvocationStateSchema
>;

export const commandInvocationResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("result"),
      sanitized: z.literal(true),
      value: runCommandResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      sanitized: z.literal(true),
      value: serializedErrorSchema,
    })
    .strict(),
]);
export type CommandInvocationResponse = z.infer<
  typeof commandInvocationResponseSchema
>;

export const commandInvocationRecoverySchema = z
  .object({
    code: z.literal("EXECUTION_OUTCOME_UNKNOWN"),
    priorState: z.literal("executing"),
    recoveredAt: z.iso.datetime(),
  })
  .strict();
export type CommandInvocationRecovery = z.infer<
  typeof commandInvocationRecoverySchema
>;

export const commandInvocationRecordSchema = z
  .object({
    version: z.literal(1),
    invocationId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    idempotencyKey: sha256Schema,
    planFingerprint: sha256Schema,
    state: commandInvocationStateSchema,
    sequence: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    response: commandInvocationResponseSchema.optional(),
    recovery: commandInvocationRecoverySchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const terminal =
      record.state === "completed" ||
      record.state === "blocked" ||
      record.state === "outcome_unknown";

    if (terminal && record.expiresAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Terminal command invocations require expiresAt.",
      });
    }
    if (!terminal && record.expiresAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Active command invocations cannot expire.",
      });
    }

    if (record.updatedAt < record.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt cannot precede createdAt.",
      });
    }
    if (
      record.expiresAt !== undefined &&
      record.expiresAt < record.updatedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt cannot precede updatedAt.",
      });
    }

    switch (record.state) {
      case "awaiting_confirmation":
        if (
          record.response?.kind !== "result" ||
          record.response.value.status !== "confirmation_required"
        ) {
          context.addIssue({
            code: "custom",
            path: ["response"],
            message:
              "awaiting_confirmation requires a sanitized confirmation_required result.",
          });
        }
        if (record.recovery !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["recovery"],
            message: "Only outcome_unknown can contain recovery metadata.",
          });
        }
        break;
      case "completed":
        if (
          record.response?.kind !== "result" ||
          record.response.value.status !== "executed"
        ) {
          context.addIssue({
            code: "custom",
            path: ["response"],
            message: "completed requires a sanitized executed result.",
          });
        }
        if (record.recovery !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["recovery"],
            message: "Only outcome_unknown can contain recovery metadata.",
          });
        }
        break;
      case "blocked":
        if (record.response?.kind !== "error") {
          context.addIssue({
            code: "custom",
            path: ["response"],
            message: "blocked requires a sanitized serialized error.",
          });
        }
        if (record.recovery !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["recovery"],
            message: "Only outcome_unknown can contain recovery metadata.",
          });
        }
        break;
      case "outcome_unknown":
        if (
          record.response?.kind !== "error" ||
          record.response.value.code !== "EXECUTION_OUTCOME_UNKNOWN"
        ) {
          context.addIssue({
            code: "custom",
            path: ["response"],
            message:
              "outcome_unknown requires EXECUTION_OUTCOME_UNKNOWN as its sanitized error.",
          });
        }
        if (record.recovery === undefined) {
          context.addIssue({
            code: "custom",
            path: ["recovery"],
            message: "outcome_unknown requires recovery metadata.",
          });
        }
        break;
      default:
        if (record.response !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["response"],
            message:
              "This active command invocation state cannot contain a replay response.",
          });
        }
        if (record.recovery !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["recovery"],
            message: "Only outcome_unknown can contain recovery metadata.",
          });
        }
    }
  });
export type CommandInvocationRecord = z.infer<
  typeof commandInvocationRecordSchema
>;

export const commandInvocationMetricsSchema = z
  .object({
    entries: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    replayable: z.number().int().nonnegative(),
    outcomeUnknown: z.number().int().nonnegative(),
    hits: z.number().int().nonnegative(),
    misses: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    evictions: z.number().int().nonnegative(),
    expirations: z.number().int().nonnegative(),
    recoveries: z.number().int().nonnegative(),
  })
  .strict();
export type CommandInvocationMetrics = z.infer<
  typeof commandInvocationMetricsSchema
>;
