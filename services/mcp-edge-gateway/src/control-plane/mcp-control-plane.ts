import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import { EdgeAuthenticationError, type EdgeAuthenticator } from "./auth.js";

const MCP_TOOL_CATALOG_META_KEY = "io.github.ifael/mcp-tool-catalog";
const AGENT_UNAVAILABLE_ERROR_CODE = -32001;

type EdgeMcpResponseDiagnostic = {
  mcpErrorCode?: number;
  mcpErrorDataCode?: string;
  catalogContractRevision?: string;
  toolSetRevision?: string;
  toolCount?: number;
  serverVersion?: string;
  connectionGeneration?: number;
};

const responseDiagnostics = new WeakMap<Response, EdgeMcpResponseDiagnostic>();

export function getMcpResponseDiagnostic(response: Response): EdgeMcpResponseDiagnostic | undefined {
  return responseDiagnostics.get(response);
}

export interface EdgeExecutionTransport {
  isReady(): boolean;
  getGeneration(): number | null;
  waitUntilReady?(): Promise<boolean>;
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

export interface EdgeMcpCatalog {
  manifest: readonly EdgeMcpToolDescriptor[];
  catalogMetadata: Readonly<Record<string, unknown>>;
  serverIdentity: Readonly<{ name: string; version: string }>;
}

export interface EdgeLocalMcpToolHandler {
  handle(
    body: unknown,
    principal: AuthenticatedEdgePrincipal,
    request?: Request,
  ): Promise<Response | null>;
}

export interface EdgeMcpControlPlaneOptions extends EdgeMcpCatalog {
  authenticator: EdgeAuthenticator;
  execution: EdgeExecutionTransport;
  localTools?: EdgeLocalMcpToolHandler;
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
        const response = jsonRpcResult(parsed.id, {
          protocolVersion: requestedProtocolVersion,
          capabilities: {
            tools: { listChanged: true },
            experimental: {
              [MCP_TOOL_CATALOG_META_KEY]: options.catalogMetadata,
            },
          },
          serverInfo: options.serverIdentity,
        });
        attachCatalogDiagnostic(response, options);
        return response;
      }

      if (parsed.method === "ping") {
        return jsonRpcResult(parsed.id, {});
      }

      if (parsed.method === "notifications/initialized") {
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }

      if (parsed.method === "tools/list") {
        const response = jsonRpcResult(parsed.id, {
          tools: options.manifest,
          _meta: {
            [MCP_TOOL_CATALOG_META_KEY]: options.catalogMetadata,
          },
        });
        attachCatalogDiagnostic(response, options);
        return response;
      }

      if (parsed.method === "tools/call" && options.localTools) {
        const localResponse = await options.localTools.handle(parsed.raw, principal, request);
        if (localResponse) return localResponse;
      }

      if (!options.execution.isReady()) {
        const recovered = await options.execution.waitUntilReady?.() ?? false;
        if (!recovered) return createAgentUnavailableMcpResponse(parsed.raw);
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

export function createAgentUnavailableMcpResponse(body: unknown): Response {
  return jsonRpcError(readId(body), AGENT_UNAVAILABLE_ERROR_CODE, "Execution backend unavailable", {
    code: "AGENT_UNAVAILABLE",
  });
}

function attachCatalogDiagnostic(response: Response, options: EdgeMcpControlPlaneOptions): void {
  const diagnostic: EdgeMcpResponseDiagnostic = {};
  const contractRevision = options.catalogMetadata.contractRevision;
  const toolSetRevision = options.catalogMetadata.toolSetRevision;
  const toolCount = options.catalogMetadata.toolCount;
  const serverVersion = options.catalogMetadata.serverVersion;
  const connectionGeneration = options.execution.getGeneration();

  if (typeof contractRevision === "string") diagnostic.catalogContractRevision = contractRevision;
  if (typeof toolSetRevision === "string") diagnostic.toolSetRevision = toolSetRevision;
  if (typeof toolCount === "number" && Number.isFinite(toolCount)) diagnostic.toolCount = toolCount;
  if (typeof serverVersion === "string") diagnostic.serverVersion = serverVersion;
  if (connectionGeneration !== null) diagnostic.connectionGeneration = connectionGeneration;

  responseDiagnostics.set(response, diagnostic);
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
  const response = jsonResponse({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
  const dataCode = isRecord(data) && typeof data.code === "string" ? data.code.slice(0, 64) : undefined;
  responseDiagnostics.set(response, {
    mcpErrorCode: code,
    ...(dataCode === undefined ? {} : { mcpErrorDataCode: dataCode }),
  });
  return response;
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
