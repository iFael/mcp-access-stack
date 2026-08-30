export interface EdgeOAuthRouteHandler {
  handle(request: Request): Promise<Response | null>;
}

export interface EdgeMcpControlPlaneHandler {
  handle(request: Request): Promise<Response>;
}

export interface McpSessionRouter {
  route(request: Request): Promise<Response | null>;
}

export function createMcpSessionRouter(options: {
  oauth: EdgeOAuthRouteHandler;
  controlPlane: EdgeMcpControlPlaneHandler;
}): McpSessionRouter {
  return {
    async route(request: Request): Promise<Response | null> {
      const oauthResponse = await options.oauth.handle(request);
      if (oauthResponse) return oauthResponse;

      const url = new URL(request.url);
      if (url.pathname === "/mcp" && request.method === "POST") {
        return options.controlPlane.handle(request);
      }
      return null;
    },
  };
}