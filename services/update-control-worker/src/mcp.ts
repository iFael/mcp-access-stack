import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import {
  UPDATE_CONTROL_CATALOG_METADATA,
  UPDATE_CONTROL_TOOL_MANIFEST,
} from "@mcp-access-stack/update-control-contract";
import type { UpdateControlReadOnlyTools } from "./tools.js";

const TOOL_CATALOG_META_KEY = "io.github.ifael/mcp-tool-catalog";
const DEFAULT_REQUEST_LIMIT = 64 * 1024;
const MAX_MCP_RESPONSE_BYTES = 512 * 1024;

export interface UpdateControlMcpHandlerOptions {
  readonly authenticate: (request: Request) => Promise<AuthenticatedEdgePrincipal>;
  readonly tools: UpdateControlReadOnlyTools;
  readonly maxRequestBytes?: number;
}

export type UpdateControlMcpHandler = (request: Request) => Promise<Response>;

export function createUpdateControlMcpHandler(
  options: UpdateControlMcpHandlerOptions,
): UpdateControlMcpHandler {
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_REQUEST_LIMIT;
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 256 * 1024) {
    throw new Error("maxRequestBytes must be between 1 and 262144.");
  }

  return async (request): Promise<Response> => {
    let principal: AuthenticatedEdgePrincipal;
    try {
      principal = await options.authenticate(request);
    } catch (error) {
      if (isAuthenticationResponseError(error)) return error.toResponse();
      return jsonResponse({ error: "authentication_unavailable" }, 503);
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
    }

    const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return jsonRpcError(null, -32600, "Content-Type must be application/json.", 415);
    }
    let text: string;
    try {
      text = await readBoundedBody(request, maxRequestBytes);
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        return jsonRpcError(null, -32600, "Request body exceeds the configured limit.", 413);
      }
      return jsonRpcError(null, -32700, "Request body could not be read.", 400);
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return jsonRpcError(null, -32700, "Parse error.", 200);
    }
    if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" ||
        !hasValidId(value)) {
      return jsonRpcError(readId(value), -32600, "Invalid Request.", 200);
    }

    if (value.method === "notifications/initialized" && value.id === undefined) {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (value.id === undefined) {
      return jsonRpcError(null, -32600, "Request id is required.", 200);
    }
    const id = value.id;

    if (value.method === "initialize") {
      const params = isRecord(value.params) ? value.params : {};
      const protocolVersion = typeof params.protocolVersion === "string" &&
        params.protocolVersion.length <= 64
        ? params.protocolVersion
        : "2025-06-18";
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mcp-v3-update-control", version: "0.1.0" },
      });
    }
    if (value.method === "ping") return jsonRpcResult(id, {});
    if (value.method === "tools/list") {
      return jsonRpcResult(id, {
        tools: UPDATE_CONTROL_TOOL_MANIFEST,
        _meta: { [TOOL_CATALOG_META_KEY]: UPDATE_CONTROL_CATALOG_METADATA },
      });
    }
    if (value.method === "tools/call") {
      if (principal.ownerScope !== "owner" || !principal.scopes.includes("update:read")) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: "Owner read access is required." }],
          structuredContent: { code: "ACCESS_DENIED" },
          isError: true,
        });
      }
      const response = await options.tools.handle(value, principal);
      if (response) {
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.byteLength > MAX_MCP_RESPONSE_BYTES) {
          return toolSizeError(id);
        }
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      }
      return jsonRpcResult(id, {
        content: [{ type: "text", text: "Unknown read-only tool." }],
        structuredContent: { code: "UNKNOWN_TOOL" },
        isError: true,
      });
    }

    return jsonRpcError(id, -32601, "Method not found.", 200);
  };
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await request.body?.cancel();
    throw new RequestTooLargeError();
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RequestTooLargeError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  const response = jsonResponse({ jsonrpc: "2.0", id, result });
  return response;
}

function jsonRpcError(id: string | number | null, code: number, message: string, status: number): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function toolSizeError(id: JsonRpcId): Response {
  return jsonRpcResult(id, {
    content: [{ type: "text", text: "The Update Control response exceeded its bounded size." }],
    structuredContent: { code: "RESULT_TOO_LARGE" },
    isError: true,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).byteLength > MAX_MCP_RESPONSE_BYTES) {
    return new Response(null, { status: 500, headers: { "cache-control": "no-store" } });
  }
  return new Response(encoded, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function readId(value: unknown): string | number | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
}

type JsonRpcId = string | number | null;

function hasValidId(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { readonly id?: JsonRpcId } {
  return !Object.hasOwn(value, "id") ||
    value.id === null ||
    typeof value.id === "string" ||
    (typeof value.id === "number" && Number.isFinite(value.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthenticationResponseError(
  error: unknown,
): error is { toResponse(): Response } {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "EdgeAuthenticationError" &&
    "toResponse" in error && typeof error.toResponse === "function";
}

class RequestTooLargeError extends Error {}
