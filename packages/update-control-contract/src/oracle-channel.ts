import type {
  UpdateGetRunArguments,
  UpdateListRunsArguments,
  UpdateWaitEventsArguments,
} from "./index.js";

export const ORACLE_CHANNEL_CONNECT_PATH = "/_internal/oracle-channel";
export const ORACLE_CHANNEL_RPC_PATH = "/_internal/rpc";
export const ORACLE_CHANNEL_ORIGIN = "https://mcp-v3-update-control-oracle.invalid";
export const ORACLE_CHANNEL_SCOPE = "oracle-release-orchestrator-v1";
export const ORACLE_CHANNEL_MAX_FRAME_BYTES = 512 * 1024;
export const ORACLE_CHANNEL_MAX_ARGUMENT_BYTES = 4 * 1024;
export const ORACLE_CHANNEL_MAX_IN_FLIGHT = 32;
export const ORACLE_CHANNEL_BASE_RPC_TIMEOUT_MS = 5_000;
export const ORACLE_CHANNEL_WAIT_RPC_GRACE_MS = 5_000;
export const ORACLE_CHANNEL_MAX_RPC_TIMEOUT_MS = 20_000;

export type OracleChannelReadCommand =
  | { readonly method: "list_runs"; readonly arguments: UpdateListRunsArguments }
  | { readonly method: "get_run"; readonly arguments: UpdateGetRunArguments }
  | { readonly method: "wait_events"; readonly arguments: UpdateWaitEventsArguments };

export type OracleChannelRequestFrame = {
  readonly version: 1;
  readonly type: "request";
  readonly requestId: string;
} & OracleChannelReadCommand;

export type OracleChannelResponseFrame =
  | {
      readonly version: 1;
      readonly type: "response";
      readonly requestId: string;
      readonly outcome: "success";
      readonly result: unknown;
    }
  | {
      readonly version: 1;
      readonly type: "response";
      readonly requestId: string;
      readonly outcome: "error";
      readonly errorCode: "RUN_NOT_FOUND" | "UPDATE_ORCHESTRATOR_UNAVAILABLE";
    };
