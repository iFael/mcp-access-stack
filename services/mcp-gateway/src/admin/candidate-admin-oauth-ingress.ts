import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const READ_SCOPE = "candidate99:read";
const MAX_BODY = "32kb";
const MAX_TOKEN_LENGTH = 4096;
const PRIVATE_MCP_URL = "http://127.0.0.1:39199/mcp";
const ALLOWED_TOOLS = new Set(["candidate_service_status", "candidate_operation_status"]);
const ALLOWED_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);

export type IntrospectionResponse = {
  active?: boolean;
  iss?: string;
  sub?: string;
  aud?: string | string[];
  scope?: string;
  exp?: number;
};

export type PrivateOauthIngressConfig = {
  publicBaseUrl: string;
  authorizationServer: string;
  introspectionUrl: string;
  clientId: string;
  clientSecret: string;
  loopbackToken: string;
  introspect?: (token: string) => Promise<IntrospectionResponse>;
  forward?: (payload: unknown) => Promise<{ status: number; body: string }>;
};

function httpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw Error("PRIVATE_INGRESS_HTTPS_URL_REQUIRED");
  }
  return url;
}

export function createCandidateAdminOauthIngressApp(options: PrivateOauthIngressConfig): Express {
  const base = httpsOrigin(options.publicBaseUrl);
  const issuer = httpsOrigin(options.authorizationServer);
  const introspection = httpsOrigin(options.introspectionUrl);
  if (base.pathname !== "/" || base.origin === issuer.origin ||
      introspection.origin !== issuer.origin ||
      !/^[A-Za-z0-9._~-]{1,128}$/u.test(options.clientId) ||
      options.clientSecret.length < 32 ||
      !/^[A-Za-z0-9_-]{48,256}$/u.test(options.loopbackToken)) {
    throw Error("PRIVATE_INGRESS_CONFIG_INVALID");
  }
  const resource = new URL("/mcp", base).href;
  const resourceMetadata = new URL("/.well-known/oauth-protected-resource/mcp", base).href;
  const clientAuthorization = "Basic " + Buffer.from(
    options.clientId + ":" + options.clientSecret, "utf8",
  ).toString("base64");

  const introspect = options.introspect ?? (async (token: string): Promise<IntrospectionResponse> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(introspection, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: clientAuthorization,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ token, token_type_hint: "access_token" }),
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        throw Error("PRIVATE_OAUTH_INTROSPECTION_FAILED");
      }
      return await response.json() as IntrospectionResponse;
    } finally {
      clearTimeout(timeout);
    }
  });

  const forward = options.forward ?? (async (payload: unknown) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(PRIVATE_MCP_URL, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: "Bearer " + options.loopbackToken,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) {
        throw Error("PRIVATE_MCP_UPSTREAM_UNAVAILABLE");
      }
      const body = await response.text();
      if (body.length > 262144) throw Error("PRIVATE_MCP_RESPONSE_TOO_LARGE");
      return { status: 200, body };
    } finally {
      clearTimeout(timeout);
    }
  });

  const challenge = `Bearer resource_metadata="${resourceMetadata}", scope="${READ_SCOPE}"`;
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({ resource, authorization_servers: [issuer.href], scopes_supported: [READ_SCOPE],
      resource_name: "MCP connector99 private read-only administration" });
  });
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource, authorization_servers: [issuer.href], scopes_supported: [READ_SCOPE],
      resource_name: "MCP connector99 private read-only administration" });
  });
  app.get("/health/live", (_req, res) => res.json({ status: "live" }));

  const authorize: RequestHandler = async (req, res, next) => {
    if (req.headers.origin !== undefined || req.headers.cookie !== undefined) {
      res.status(403).json({ error: "browser_access_not_allowed" });
      return;
    }
    const header = req.headers.authorization ?? "";
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(header);
    if (!match || match[1]!.length > MAX_TOKEN_LENGTH) {
      res.setHeader("WWW-Authenticate", challenge);
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    try {
      const claims = await introspect(match[1]!);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.active !== true || claims.iss !== issuer.href ||
          typeof claims.sub !== "string" || claims.sub.length < 1 ||
          !audiences.includes(resource) || !Number.isSafeInteger(claims.exp) ||
          claims.exp! <= Math.floor(Date.now() / 1000) ||
          !claims.scope?.split(/\s+/u).includes(READ_SCOPE)) {
        res.setHeader("WWW-Authenticate", challenge);
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "identity_provider_unavailable" });
    }
  };

  const limiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: "draft-7",
    legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: "rate_limited" }) });
  app.use("/mcp", limiter);
  app.all("/mcp", authorize);
  app.post("/mcp", express.json({ limit: MAX_BODY, type: ["application/json", "application/*+json"] }),
    async (req, res) => {
      const call = req.body;
      if (!call || typeof call !== "object" || Array.isArray(call) ||
          call.jsonrpc !== "2.0" || typeof call.method !== "string" ||
          !ALLOWED_METHODS.has(call.method) ||
          (call.method === "tools/call" && !ALLOWED_TOOLS.has(call.params?.name))) {
        res.status(403).json({ error: "method_not_allowed" });
        return;
      }
      try {
        const upstream = await forward(call);
        res.type("application/json").status(upstream.status).send(upstream.body);
      } catch {
        res.status(502).json({ error: "private_mcp_unavailable" });
      }
    },
  );
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
  return app;
}
