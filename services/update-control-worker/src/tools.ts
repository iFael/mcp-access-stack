import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import {
  UPDATE_CONTROL_TOOL_MANIFEST,
  UpdateControlInputError,
  parseUpdateGetRunArguments,
  parseUpdateListRunsArguments,
  parseUpdateWaitEventsArguments,
  type UpdateGetRunArguments,
  type UpdateGetRunResult,
  type UpdateListRunsArguments,
  type UpdateListRunsResult,
  type UpdateWaitEventsArguments,
  type UpdateWaitEventsResult,
} from "@mcp-access-stack/update-control-contract";

const MAX_TOOL_RESULT_BYTES = 256 * 1024;

export interface UpdateControlReadClient {
  listRuns(input: UpdateListRunsArguments): Promise<UpdateListRunsResult>;
  getRun(input: UpdateGetRunArguments): Promise<UpdateGetRunResult>;
  waitEvents(input: UpdateWaitEventsArguments): Promise<UpdateWaitEventsResult>;
}

export interface UpdateControlReadOnlyTools {
  readonly manifest: typeof UPDATE_CONTROL_TOOL_MANIFEST;
  handle(body: unknown, principal: AuthenticatedEdgePrincipal): Promise<Response | null>;
}

export function createUpdateControlReadOnlyTools(
  client: UpdateControlReadClient,
): UpdateControlReadOnlyTools {
  return {
    manifest: UPDATE_CONTROL_TOOL_MANIFEST,
    async handle(body, principal) {
      if (!isRecord(body) || body.method !== "tools/call") return null;
      const id = readJsonRpcId(body.id);
      const params = isRecord(body.params) ? body.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments === undefined ? {} : params.arguments;

      if (!UPDATE_CONTROL_TOOL_MANIFEST.some((tool) => tool.name === name)) {
        return toolError(id, "UNKNOWN_TOOL", "This Update Control server exposes read-only run observation tools.");
      }
      if (principal.ownerScope !== "owner" || !principal.scopes.includes("update:read")) {
        return toolError(id, "ACCESS_DENIED", "Owner read access is required.");
      }

      try {
        if (name === "update_list_runs") {
          return toolSuccess(id, await client.listRuns(parseUpdateListRunsArguments(args)));
        }
        if (name === "update_get_run") {
          return toolSuccess(id, await client.getRun(parseUpdateGetRunArguments(args)));
        }
        return toolSuccess(id, await client.waitEvents(parseUpdateWaitEventsArguments(args)));
      } catch (error) {
        if (error instanceof UpdateControlInputError) {
          return toolError(id, "INVALID_ARGUMENT", error.message);
        }
        const code = error instanceof UpdateControlClientError
          ? error.code
          : "UPDATE_ORCHESTRATOR_UNAVAILABLE";
        return toolError(id, code, "The Oracle Release Orchestrator could not complete this read.");
      }
    },
  };
}

export class UpdateControlClientError extends Error {
  constructor(readonly code: "RUN_NOT_FOUND" | "UPDATE_ORCHESTRATOR_UNAVAILABLE") {
    super(code);
    this.name = "UpdateControlClientError";
  }
}

function toolSuccess(id: string | number | null, value: unknown): Response {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return toolError(id, "INVALID_RESULT", "The Update Control result could not be serialized.");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_TOOL_RESULT_BYTES) {
    return toolError(id, "RESULT_TOO_LARGE", "The Update Control result exceeded the response limit.");
  }
  return jsonRpcResult(id, {
    content: [{ type: "text", text }],
    structuredContent: value,
    isError: false,
  });
}

function toolError(id: string | number | null, code: string, message: string): Response {
  return jsonRpcResult(id, {
    content: [{ type: "text", text: message }],
    structuredContent: { code },
    isError: true,
  });
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function readJsonRpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
