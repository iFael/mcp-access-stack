/** Dedicated authenticated release-control channel. Never share the read-channel
 * token, scope, URL or bearer with this mutating protocol. */
export const ORACLE_CONTROL_CONNECT_PATH = "/_internal/oracle-release-control";
export const ORACLE_CONTROL_RPC_PATH = "/_internal/oracle-release-control-rpc";
export const ORACLE_CONTROL_DISPATCH_PATH = "/_internal/oracle-release-advance";
export const ORACLE_CONTROL_SCOPE = "oracle-release-control-v1";
export const ORACLE_CONTROL_ORIGIN = "https://mcp-v3-oracle-release-control.invalid";
export const ORACLE_CONTROL_MAX_BODY_BYTES = 4 * 1024;
export const ORACLE_CONTROL_TIMEOUT_MS = 20_000;

export interface OracleControlAdvanceInput {
  readonly runId: string;
  readonly expectedSourceSha: string;
  readonly expectedLastSeq: number;
  /** Fixed client request identity for audit/correlation, not a retry permit. */
  readonly operationId: string;
}
export interface OracleControlPrincipal {
  readonly workspaceId: string;
  readonly authenticatedActorId: string;
  readonly ownerScope: string;
}
export interface OracleControlRpcCommand {
  readonly method: "advance_release";
  readonly arguments: OracleControlAdvanceInput;
  readonly principal: OracleControlPrincipal;
}
export interface OracleControlResponse {
  readonly runId: string;
  readonly lastSeq: number;
  readonly status: string;
  readonly stop: string;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA=/^[0-9a-f]{40}$/u;

export function parseOracleControlAdvance(value:unknown):OracleControlAdvanceInput {
  if(!isRecord(value) || !exact(value,["runId","expectedSourceSha","expectedLastSeq","operationId"]) ||
    typeof value.runId!=="string" || !UUID.test(value.runId) ||
    typeof value.operationId!=="string" || !UUID.test(value.operationId) ||
    typeof value.expectedSourceSha!=="string" || !SHA.test(value.expectedSourceSha) ||
    !Number.isSafeInteger(value.expectedLastSeq) || (value.expectedLastSeq as number)<0) {
    throw new Error("ORACLE_CONTROL_INVALID_ARGUMENT");
  }
  return value as unknown as OracleControlAdvanceInput;
}
export function parseOracleControlCommand(value:unknown):OracleControlRpcCommand {
  if(!isRecord(value) || !exact(value,["method","arguments","principal"]) ||
    value.method!=="advance_release" || !isRecord(value.principal) ||
    !exact(value.principal,["workspaceId","authenticatedActorId","ownerScope"]) ||
    value.principal.workspaceId!=="mcp-access-stack" ||
    value.principal.authenticatedActorId!=="mcp:v3-release-control" ||
    value.principal.ownerScope!=="trusted:release-operator") {
    throw new Error("ORACLE_CONTROL_INVALID_COMMAND");
  }
  return {method:"advance_release",
    arguments:parseOracleControlAdvance(value.arguments),
    principal: value.principal as unknown as OracleControlPrincipal};
}
export function parseOracleControlResponse(value:unknown):OracleControlResponse {
  if(!isRecord(value) || !exact(value,["runId","lastSeq","status","stop"]) ||
    typeof value.runId!=="string" || !UUID.test(value.runId) ||
    !Number.isSafeInteger(value.lastSeq) || (value.lastSeq as number)<0 ||
    typeof value.status!=="string" || !["planned","running","paused_outcome_unknown","failed","succeeded"].includes(value.status) ||
    typeof value.stop!=="string" || !["outcome_unknown","succeeded","step_limit","blocked_gate","blocked_missing_capability","blocked_unauthorized","operation_in_progress","reconciled_not_applied","failed"].includes(value.stop)) {
    throw new Error("ORACLE_CONTROL_INVALID_RESPONSE");
  }
  return value as unknown as OracleControlResponse;
}
function isRecord(x:unknown):x is Record<string,unknown> {
  return x!==null && typeof x==="object" && !Array.isArray(x);
}
function exact(x:Record<string,unknown>,keys:string[]):boolean {
  const actual=Object.keys(x);
  return actual.length===keys.length && keys.every(k=>Object.hasOwn(x,k));
}
