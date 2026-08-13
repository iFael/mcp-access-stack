import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";

const proxyHost = readHost("PROXY_HOST", "127.0.0.1");
const proxyPort = readPort("PROXY_PORT", 3400);
const targetHost = readHost("TARGET_HOST", "127.0.0.1");
const targetPort = readPort("TARGET_PORT", 3410);
const mcpPath = normalizePath(process.env.MCP_PATH ?? "/mcp");
const mcpPathAliases = readPathAliases("MCP_PATH_ALIASES");
const upstreamResponseTimeoutMs = readTimeout(
  "PROXY_UPSTREAM_RESPONSE_TIMEOUT_MS",
  300_000,
);

function readHost(name, fallback) {
  const value = String(process.env[name] ?? fallback).trim();
  if (!value || value.length > 253 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${name} must be a valid hostname or IP address.`);
  }
  return value;
}

function readPort(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return value;
}

function readTimeout(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    throw new Error(name + " must be between 1 and 300000 milliseconds.");
  }
  return value;
}

function normalizePath(value) {
  const path = String(value).trim();
  if (!path.startsWith("/") || path.length < 2) {
    throw new Error("MCP_PATH must be an absolute non-root path.");
  }
  return path.replace(/\/+$/, "");
}

function readPathAliases(name) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return [];
  const aliases = raw
    .split(",")
    .map((value) => normalizePath(value))
    .filter((value) => value !== mcpPath);
  return [...new Set(aliases)];
}

function pathnameOf(url) {
  return (url ?? "/").split("?")[0];
}

function resolveRoute(url) {
  const rawUrl = url ?? "/";
  const pathname = pathnameOf(rawUrl);
  const routeBase = [mcpPath, ...mcpPathAliases].find(
    (candidate) => pathname === candidate || pathname.startsWith(`${candidate}/`),
  );
  if (!routeBase) return null;
  if (routeBase === mcpPath) return { upstreamUrl: rawUrl, alias: false };
  const queryIndex = rawUrl.indexOf("?");
  const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : "";
  const suffix = pathname.slice(routeBase.length);
  return { upstreamUrl: `${mcpPath}${suffix}${query}`, alias: true };
}

function hostPort(host, port) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function log(event, fields = {}, level = "info") {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "gpt-mcp-proxy",
    level,
    event,
    ...fields,
  });
  (level === "error" ? console.error : console.log)(line);
}

const server = createServer((clientRequest, clientResponse) => {
  const url = clientRequest.url ?? "/";
  const pathname = pathnameOf(url);

  if (url === "/health/live") {
    clientResponse.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    clientResponse.end(
      JSON.stringify({
        status: "live",
        route: mcpPath,
        aliasCount: mcpPathAliases.length,
        target: hostPort(targetHost, targetPort),
      }),
    );
    return;
  }

  const route = resolveRoute(url);
  if (!route) {
    clientResponse.writeHead(404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    clientResponse.end(JSON.stringify({ error: "route_not_found", url: pathname }));
    return;
  }

  const requestId = randomUUID();
  const startedAt = Date.now();
  let completed = false;
  let upstreamStatus;
  let upstreamTimedOut = false;
  const common = {
    requestId,
    method: clientRequest.method ?? "UNKNOWN",
    path: pathname,
    hasMcpSessionId: Boolean(clientRequest.headers["mcp-session-id"]),
    hasLastEventId: Boolean(clientRequest.headers["last-event-id"]),
  };
  log("proxy_request_started", common);
  clientResponse.setHeader("x-mcp-proxy-request-id", requestId);

  const finish = (event, level = "info", extra = {}) => {
    if (completed) return;
    completed = true;
    log(
      event,
      {
        ...common,
        durationMs: Date.now() - startedAt,
        upstreamStatus: upstreamStatus ?? null,
        ...extra,
      },
      level,
    );
  };

  const proxyRequest = request(
    {
      hostname: targetHost,
      port: targetPort,
      path: route.upstreamUrl,
      method: clientRequest.method,
      headers: clientRequest.headers,
    },
    (proxyResponse) => {
      clearTimeout(upstreamResponseTimer);
      upstreamStatus = proxyResponse.statusCode ?? 502;
      log("proxy_upstream_response", {
        ...common,
        upstreamStatus,
        hasMcpSessionId: Boolean(proxyResponse.headers["mcp-session-id"]),
      });
      clientResponse.writeHead(upstreamStatus, proxyResponse.headers);
      proxyResponse.on("aborted", () => {
        finish("proxy_upstream_aborted", "error");
        clientResponse.destroy();
      });
      proxyResponse.on("error", (error) => {
        finish("proxy_upstream_stream_error", "error", {
          reason: error.name,
          code: error.code ?? null,
        });
        clientResponse.destroy(error);
      });
      proxyResponse.pipe(clientResponse);
    },
  );

  const upstreamResponseTimer = setTimeout(() => {
    upstreamTimedOut = true;
    finish("proxy_upstream_timeout", "error", {
      reason: "upstream_timeout",
      terminatedBy: "proxy",
      timeoutMs: upstreamResponseTimeoutMs,
    });
    proxyRequest.destroy();
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(504, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      clientResponse.end(
        JSON.stringify({
          error: "upstream_timeout",
          reason: "upstream_timeout",
          terminatedBy: "proxy",
        }),
      );
    }
  }, upstreamResponseTimeoutMs);
  upstreamResponseTimer.unref();

  clientRequest.once("aborted", () => {
    clearTimeout(upstreamResponseTimer);
    finish("proxy_client_aborted", "error", {
      reason: "client_disconnected",
      terminatedBy: "proxy",
    });
    proxyRequest.destroy();
  });
  clientResponse.once("finish", () => {
    clearTimeout(upstreamResponseTimer);
    finish("proxy_request_completed");
  });
  clientResponse.once("close", () => {
    if (!clientResponse.writableEnded) {
      clearTimeout(upstreamResponseTimer);
      finish("proxy_client_connection_closed", "error", {
        reason: "client_disconnected",
        terminatedBy: "proxy",
      });
      proxyRequest.destroy();
    }
  });

  proxyRequest.on("error", (error) => {
    clearTimeout(upstreamResponseTimer);
    if (upstreamTimedOut) return;
    finish("proxy_upstream_connection_error", "error", {
      reason: error.name,
      code: error.code ?? null,
    });
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      clientResponse.end(JSON.stringify({ error: "bad_gateway" }));
      return;
    }
    clientResponse.end();
  });

  clientRequest.pipe(proxyRequest);
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.on("clientError", (error, socket) => {
  log(
    "proxy_client_protocol_error",
    { reason: error.name, code: error.code ?? null },
    "error",
  );
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
});

server.on("error", (error) => {
  log("proxy_server_error", { reason: error.name, code: error.code ?? null }, "error");
  process.exitCode = 1;
});

server.listen(proxyPort, proxyHost, () => {
  log("proxy_started", {
    listen: hostPort(proxyHost, proxyPort),
    route: mcpPath,
    aliasCount: mcpPathAliases.length,
    target: hostPort(targetHost, targetPort),
    upstreamResponseTimeoutMs,
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("proxy_stopping", { signal });
  server.close((error) => {
    if (error) {
      log("proxy_stop_failed", { reason: error.name }, "error");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
