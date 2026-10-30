import { z } from "zod";

// mcp_update: the execution node publishes MAIN to itself and to the user's
// Windows companion, step by step, and moves the plan card the agent opened. The agent starts it, ends its answer
// and is woken when the update succeeds, fails or needs a confirmation.

const SHA = z.string().regex(/^[a-f0-9]{40}$/u);
const UPDATE_ID = z.string().regex(/^upd_[0-9a-f-]{36}$/u);
const PLAN_ID = z.string().regex(/^plan_[0-9a-f-]{36}$/u);
const CONFIRMATION_ID = z.string().trim().min(1).max(128);

export const MCP_UPDATE_STEP_IDS = [
  "precheck", "edge_stage", "edge_activate", "connector_tag", "connector_release",
  "oracle_prepare", "oracle_promote", "oracle_verify",
  "companion_release", "windows_prepare", "windows_promote",
] as const;

export const mcpUpdateInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    workspaceId: z.literal("mcp-access-stack"),
    expectedMainSha: SHA,
    planId: PLAN_ID.optional(),
  }).strict(),
  z.object({
    action: z.literal("read"),
    workspaceId: z.literal("mcp-access-stack"),
    updateId: UPDATE_ID.optional(),
  }).strict(),
  z.object({
    action: z.literal("confirm"),
    workspaceId: z.literal("mcp-access-stack"),
    updateId: UPDATE_ID,
    confirmationId: CONFIRMATION_ID,
  }).strict(),
  z.object({
    action: z.literal("resume"),
    workspaceId: z.literal("mcp-access-stack"),
    updateId: UPDATE_ID,
  }).strict(),
]);
export type McpUpdateInput = z.infer<typeof mcpUpdateInputSchema>;

/** Object-shaped for the MCP SDK; the union above still validates each call. */
export const mcpUpdatePublishedInputSchema = z.object({
  action: z.enum(["start", "read", "confirm", "resume"]),
  workspaceId: z.literal("mcp-access-stack"),
  expectedMainSha: SHA.optional(),
  planId: PLAN_ID.optional(),
  updateId: UPDATE_ID.optional(),
  confirmationId: CONFIRMATION_ID.optional(),
}).strict();

const workflowRunSchema = z.object({
  operationId: z.uuid(),
  runId: z.number().int().positive().optional(),
}).strict();

export const mcpUpdateRecordSchema = z.object({
  updateId: UPDATE_ID,
  mainSha: SHA,
  planId: PLAN_ID.optional(),
  status: z.enum(["running", "succeeded", "failed", "needs_confirmation"]),
  step: z.enum(MCP_UPDATE_STEP_IDS),
  skipped: z.array(z.enum(MCP_UPDATE_STEP_IDS)),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
  confirmation: z.object({
    step: z.enum(["oracle_prepare", "oracle_promote", "windows_prepare", "windows_promote"]),
    confirmationId: CONFIRMATION_ID,
    reasons: z.array(z.string().min(1)),
    expiresAt: z.string().min(1),
  }).strict().optional(),
  tag: z.string().min(1).optional(),
  activeBefore: z.string().min(1).optional(),
  companionTag: z.string().min(1).optional(),
  workflows: z.object({
    stage: workflowRunSchema.optional(),
    activate: workflowRunSchema.optional(),
    bootstrap: workflowRunSchema.optional(),
    release: workflowRunSchema.optional(),
    companion: workflowRunSchema.optional(),
  }).strict(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type McpUpdateRecordResult = z.infer<typeof mcpUpdateRecordSchema>;

export const mcpUpdateResultSchema = z.object({
  update: mcpUpdateRecordSchema.nullable(),
}).strict();
export type McpUpdateResult = z.infer<typeof mcpUpdateResultSchema>;
