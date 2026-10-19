import { z } from "zod";
import { getReleaseStateResultSchema } from "./release-lifecycle-contracts.js";

const UUID=z.uuid();
const SHA=z.string().regex(/^[a-f0-9]{40}$/u);
const workspace=z.literal("mcp-access-stack");
export const oracleReleaseAdvanceInputSchema=z.object({
  workspaceId:workspace,
  runId:UUID,
  operationId:UUID,
  expectedSourceSha:SHA,
  expectedLastSeq:z.number().int().nonnegative().safe(),
}).strict();
export type OracleReleaseAdvanceInput=z.infer<typeof oracleReleaseAdvanceInputSchema>;

export const oracleReleaseAdvanceResultSchema=z.discriminatedUnion("status",[
  z.object({status:z.literal("outcome_unknown"),operationId:UUID}).strict(),
  z.object({
    status:z.literal("observed"),operationId:UUID,
    result:z.object({
      runId:UUID,lastSeq:z.number().int().nonnegative().safe(),
      status:z.enum(["planned","running","paused_outcome_unknown","failed","succeeded"]),
      stop:z.enum(["outcome_unknown","succeeded","step_limit","blocked_gate",
        "blocked_missing_capability","blocked_unauthorized","operation_in_progress",
        "reconciled_not_applied","failed"]),
    }).strict(),
  }).strict(),
]);
export type OracleReleaseAdvanceResult=z.infer<typeof oracleReleaseAdvanceResultSchema>;

/** One release-oriented entrypoint, not a stand-alone Oracle administrative tool. */
export const releaseOrchestratorInputSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("get_local_state"),workspaceId:workspace}).strict(),
  z.object({
    action:z.literal("advance_oracle"),
    ...oracleReleaseAdvanceInputSchema.shape,
  }).strict(),
]);
/** Object-shaped MCP SDK schemas; strict discriminated unions above/below still
 * validate the actual operation before dispatch and before returning. */
export const releaseOrchestratorPublishedInputSchema=z.object({
  action:z.enum(["get_local_state","advance_oracle"]),
  workspaceId:workspace,
  runId:UUID.optional(),
  operationId:UUID.optional(),
  expectedSourceSha:SHA.optional(),
  expectedLastSeq:z.number().int().nonnegative().safe().optional(),
}).strict();
export const releaseOrchestratorPublishedOutputSchema=z.object({
  action:z.enum(["get_local_state","advance_oracle"]),
  result:z.union([getReleaseStateResultSchema,oracleReleaseAdvanceResultSchema]),
}).strict();

export const releaseOrchestratorResultSchema=z.discriminatedUnion("action",[
  z.object({
    action:z.literal("get_local_state"),
    result:getReleaseStateResultSchema,
  }).strict(),
  z.object({
    action:z.literal("advance_oracle"),
    result:oracleReleaseAdvanceResultSchema,
  }).strict(),
]);
