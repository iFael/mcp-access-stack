import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BROWSER_TOOL_NAMES,
  MCP_SERVER_NAME,
  MCP_TOOL_CATALOG_META_KEY,
  WORKSPACE_TOOL_NAMES,
  createMcpToolCatalogMetadata,
  registerBrowserTools,
  registerWorkspaceTools,
  type BrowserExecutor,
  type ToolOperationContextFactory,
} from "@vs-code-gpt/shared";
import type { AgentRelay } from "../relay/service.js";
import { installChatGptToolsListCompatibility } from "./chatgpt-tools-list.js";
import { RelayWorkspaceExecutor } from "../relay/workspace-executor.js";

export interface McpServerAuthOptions {
  requiredScope: string;
  resourceMetadataUrl: URL;
}

export interface McpServerOptions {
  relay: AgentRelay;
  browser?: BrowserExecutor | undefined;
  auth?: McpServerAuthOptions | undefined;
  operationContextFactory?: ToolOperationContextFactory | undefined;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const catalogNames = options.browser === undefined
    ? WORKSPACE_TOOL_NAMES
    : [...WORKSPACE_TOOL_NAMES, ...BROWSER_TOOL_NAMES];
  const catalog = createMcpToolCatalogMetadata(catalogNames);
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: catalog.serverVersion },
    {
      capabilities: {
        tools: {},
        experimental: {
          [MCP_TOOL_CATALOG_META_KEY]: catalog,
        },
      },
    },
  );
  const securitySchemes = options.auth
    ? [{ type: "oauth2" as const, scopes: [options.auth.requiredScope] }]
    : [{ type: "noauth" as const }];

  const workspaceExecutor = new RelayWorkspaceExecutor(options.relay);
  registerWorkspaceTools(server, workspaceExecutor, {
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    securitySchemes,
    ...(options.operationContextFactory === undefined
      ? {}
      : { operationContextFactory: options.operationContextFactory }),
  });

  if (options.browser) {
    registerBrowserTools(server, options.browser, {
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      securitySchemes,
      workspaceExecutor,
      ...(options.operationContextFactory === undefined
        ? {}
        : { operationContextFactory: options.operationContextFactory }),
    });
  }

  server.server.registerCapabilities({ tools: { listChanged: false } });

  installChatGptToolsListCompatibility(server, securitySchemes, catalog);
  return server;
}
