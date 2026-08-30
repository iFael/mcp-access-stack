import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol/source";
import { EdgeAuthenticationError, type EdgeAuthenticator } from "./auth.js";

const MCP_TOOL_CATALOG_META_KEY = "io.github.ifael/mcp-tool-catalog";
const AGENT_UNAVAILABLE_ERROR_CODE = -32001;

export interface EdgeExecutionTransport {
  isReady(): boolean;
  getGeneration(): number | null;
  execute(
    body: unknown,
    principal: AuthenticatedEdgePrincipal,
    request?: Request,
  ): Promise<Response>;
}

export interface EdgeMcpToolDescriptor {
  name: string;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
  [key: string]: unknown;
}

export interface EdgeMcpControlPlaneOptions {
  authenticator: EdgeAuthenticator;
  execution: EdgeExecutionTransport;
  manifest: readonly EdgeMcpToolDescriptor[];
  catalogMetadata: Readonly<Record<string, unknown>>;
  serverIdentity: Readonly<{ name: string; version: string }>;
}

export interface EdgeMcpControlPlane {
  handle(request: Request): Promise<Response>;
}

export function createMcpControlPlane(options: EdgeMcpControlPlaneOptions): EdgeMcpControlPlane {
  return {
    async handle(request: Request): Promise<Response> {
      let principal: AuthenticatedEdgePrincipal;
      try {
        principal = await options.authenticator.authenticate(request);
      } catch (error) {
        if (error instanceof EdgeAuthenticationError) return error.toResponse();
        throw error;
      }
      const parsed = await parseJsonRpcRequest(request);
      if (parsed instanceof Response) return parsed;

      if (parsed.method === "initialize") {
        const requestedProtocolVersion = readProtocolVersion(parsed.params);
        return jsonRpcResult(parsed.id, {
          protocolVersion: requestedProtocolVersion,
          capabilities: {
            tools: { listChanged: false },
            experimental: {
              [MCP_TOOL_CATALOG_META_KEY]: options.catalogMetadata,
            },
          },
          serverInfo: options.serverIdentity,
        });
      }

      if (parsed.method === "ping") {
        return jsonRpcResult(parsed.id, {});
      }

      if (parsed.method === "notifications/initialized") {
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }

      if (parsed.method === "tools/list") {
        return jsonRpcResult(parsed.id, {
          tools: options.manifest,
          _meta: {
            [MCP_TOOL_CATALOG_META_KEY]: options.catalogMetadata,
          },
        });
      }

      if (!options.execution.isReady()) {
        return jsonRpcError(parsed.id, AGENT_UNAVAILABLE_ERROR_CODE, "Execution backend unavailable", {
          code: "AGENT_UNAVAILABLE",
        });
      }

      return options.execution.execute(parsed.raw, principal, request);
    },
  };
}

type ParsedJsonRpcRequest = {
  raw: Record<string, unknown>;
  id: string | number | null;
  method: string;
  params: unknown;
};

async function parseJsonRpcRequest(request: Request): Promise<ParsedJsonRpcRequest | Response> {
  if (request.method !== "POST") {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return jsonRpcError(readId(value), -32600, "Invalid Request");
  }

  return {
    raw: value,
    id: readId(value),
    method: value.method,
    params: value.params,
  };
}

function readProtocolVersion(params: unknown): string {
  if (isRecord(params) && typeof params.protocolVersion === "string" && params.protocolVersion.length > 0) {
    return params.protocolVersion;
  }
  return "2025-06-18";
}

function readId(value: unknown): string | number | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}