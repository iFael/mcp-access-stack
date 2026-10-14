import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CandidateServiceAdmin } from "./candidate-service.js";
import { createCandidateAdminServer } from "./candidate-admin-cli.js";

const MAX_BODY = "32kb";

/**
 * Private read-only MCP HTTP gateway. This app is NEVER mounted by createGatewayApplication,
 * nor by the public Edge MCP server. A future authenticated HTTPS front door is a separate gate.
 */
export function createCandidateAdminHttpApp(options: {
  token: string;
  admin?: CandidateServiceAdmin;
}): Express {
  if (!/^[A-Za-z0-9_-]{48,256}$/u.test(options.token)) {
    throw new Error("PRIVATE_ADMIN_TOKEN_INVALID");
  }
  const expectedHash = createHash("sha256").update(options.token, "utf8").digest();
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  const authorize: RequestHandler = (req, res, next) => {
    // Server-to-server only: never allow a browser Origin to reach private host controls.
    if (req.headers.origin !== undefined) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    const header = req.headers.authorization ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{48,256})$/u.exec(header);
    const candidate = createHash("sha256").update(match?.[1] ?? "", "utf8").digest();
    if (!match || !timingSafeEqual(expectedHash, candidate)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="candidate99-private-admin"');
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    next();
  };

  app.get("/health/live", (_req, res) => res.status(200).json({ status: "live" }));
  app.all("/mcp", authorize);
  app.post("/mcp", express.json({ limit: MAX_BODY, type: ["application/json", "application/*+json"] }),
    async (req, res) => {
      // Only two read-only tools. No remote provision_candidate_service registration.
      const server = createCandidateAdminServer(options.admin ?? new CandidateServiceAdmin(), {
        includeProvision: false,
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      try {
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: "private_admin_unavailable" });
      } finally {
        await server.close().catch(() => undefined);
      }
    },
  );
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
  return app;
}
