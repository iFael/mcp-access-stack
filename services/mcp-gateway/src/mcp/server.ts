import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppError,
  MCP_SERVER_BASE_VERSION,
  MCP_SERVER_NAME,
  MCP_TOOL_CATALOG_META_KEY,
  registerBrowserTools,
  registerRepositoryTools,
  registerSourceControlTools,
  registerWorkspaceTools,
  unavailableRepositoryExecutor,
  type BrowserExecutor,
  type McpToolCatalogMetadata,
  type RepositoryExecutor,
  type SourceControlExecutor,
  type WorkspaceExecutor,
  type ToolOperationContextFactory,
} from "@vs-code-gpt/shared";
import { installChatGptToolsListCompatibility } from "./chatgpt-tools-list.js";
import {
  registerCompanionInternalRepositoryTools,
  type CompanionRepositoryBinder,
} from "../companion/internal-repository-tools.js";

const catalogMetadataByServer = new WeakMap<McpServer, McpToolCatalogMetadata>();

export interface McpServerAuthOptions {
  requiredScope: string;
  resourceMetadataUrl: URL;
}

export interface McpServerOptions {
  workspaceExecutor: WorkspaceExecutor;
  sourceControlExecutor: SourceControlExecutor;
  repositoryExecutor?: RepositoryExecutor | undefined;
  companionRepositoryBinder?: CompanionRepositoryBinder | undefined;
  browser?: BrowserExecutor | undefined;
  auth?: McpServerAuthOptions | undefined;
  operationContextFactory?: ToolOperationContextFactory | undefined;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const catalog: McpToolCatalogMetadata = {
    contractRevision: "",
    toolSetRevision: "",
    toolCount: 0,
    serverVersion: MCP_SERVER_BASE_VERSION,
  };
  const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_BASE_VERSION };
  const server = new McpServer(
    serverInfo,
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

  registerWorkspaceTools(server, options.workspaceExecutor, {
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    securitySchemes,
    ...(options.operationContextFactory === undefined
      ? {}
      : { operationContextFactory: options.operationContextFactory }),
    sourceControlExecutor: options.sourceControlExecutor,
  });

  registerRepositoryTools(server, options.repositoryExecutor ?? unavailableRepositoryExecutor(), {
    securitySchemes,
    ...(options.operationContextFactory === undefined
      ? {}
      : { operationContextFactory: options.operationContextFactory }),
  });

  registerSourceControlTools(server, options.sourceControlExecutor, {
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    securitySchemes,
    ...(options.operationContextFactory === undefined
      ? {}
      : { operationContextFactory: options.operationContextFactory }),
  });

  registerBrowserTools(server, options.browser ?? unavailableBrowserExecutor(), {
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    securitySchemes,
    workspaceExecutor: options.workspaceExecutor,
    ...(options.operationContextFactory === undefined
      ? {}
      : { operationContextFactory: options.operationContextFactory }),
  });

  if (options.companionRepositoryBinder) {
    registerCompanionInternalRepositoryTools(server, options.companionRepositoryBinder);
  }

  const finalizedCatalog = installChatGptToolsListCompatibility(server, securitySchemes);
  Object.assign(catalog, finalizedCatalog);
  serverInfo.version = finalizedCatalog.serverVersion;
  catalogMetadataByServer.set(server, Object.freeze({ ...finalizedCatalog }));
  server.server.registerCapabilities({ tools: { listChanged: true } });
  return server;
}

export function getMcpServerCatalogMetadata(server: McpServer): McpToolCatalogMetadata {
  const metadata = catalogMetadataByServer.get(server);
  if (!metadata) {
    throw new Error("MCP server catalog identity is unavailable.");
  }
  return metadata;
}

function unavailableBrowserExecutor(): BrowserExecutor {
  const unavailable = async (): Promise<never> => {
    throw new AppError("AGENT_UNAVAILABLE", "Browser worker unavailable.");
  };
  return new Proxy({} as BrowserExecutor, {
    get: () => unavailable,
  });
}
