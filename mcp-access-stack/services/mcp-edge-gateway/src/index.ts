import { McpSession, type EdgeGatewayEnv } from "./mcp-session.js";
import {
  EDGE_SESSION_NAME,
  connectorTokenMatches,
  isAllowedEdgeRequest,
  jsonResponse,
} from "./protocol.js";

export { McpSession };

export default {
  async fetch(request: Request, env: EdgeGatewayEnv): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = env.MCP_SESSION.idFromName(EDGE_SESSION_NAME);
    const session = env.MCP_SESSION.get(sessionId);

    if (url.pathname === "/health" && request.method === "GET") {
      const status = await session.getStatus();
      return jsonResponse({
        service: "mcp-edge-gateway",
        status: "ok",
        edgeEnabled: env.MCP_EDGE_ENABLED === "true",
        connectorReady: status.connectorReady === true,
      });
    }

    if (url.pathname === "/connector") {
      const expectedToken = env.MCP_CONNECTOR_TOKEN;
      if (!expectedToken) {
        return jsonResponse({ error: "connector_auth_not_configured" }, 503);
      }

      const authorized = await connectorTokenMatches(
        request.headers.get("authorization"),
        expectedToken,
      );
      if (!authorized) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": "Bearer",
            "cache-control": "no-store",
          },
        });
      }

      return session.fetch(request);
    }

    const path = `${url.pathname}${url.search}`;
    if (isAllowedEdgeRequest(request.method, path)) {
      if (env.MCP_EDGE_ENABLED !== "true") {
        return jsonResponse({ error: "edge_not_enabled" }, 503);
      }
      return session.fetch(request);
    }

    return jsonResponse({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<EdgeGatewayEnv>;
