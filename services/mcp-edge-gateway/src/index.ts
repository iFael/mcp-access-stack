import { McpSession, type EdgeGatewayEnv } from "./mcp-session.js";
import { createEdgeHealthStatus } from "./health.js";
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
      const health = createEdgeHealthStatus(
        env.MCP_EDGE_ENABLED === "true",
        await session.getStatus(),
      );
      return jsonResponse(health.body, health.statusCode);
    }

    if (url.pathname === "/_internal/owner-oauth/bootstrap" && request.method === "POST") {
      const expectedToken = env.MCP_CONNECTOR_TOKEN;
      if (!expectedToken) return jsonResponse({ error: "connector_auth_not_configured" }, 503);
      if (!(await connectorTokenMatches(request.headers.get("authorization"), expectedToken))) {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } });
      }
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return jsonResponse({ error: "invalid_owner_bootstrap_content_type" }, 415);
      }
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 1024 * 1024) {
        return jsonResponse({ error: "owner_bootstrap_too_large" }, 413);
      }
      let input: unknown;
      try { input = JSON.parse(body) as unknown; } catch {
        return jsonResponse({ error: "invalid_owner_bootstrap" }, 400);
      }
      const result = JSON.parse(await session.bootstrapLegacyOwnerState(input)) as {
        status: number;
        body: Record<string, unknown>;
      };
      return jsonResponse(result.body, result.status);
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
