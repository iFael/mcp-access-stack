import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { OracleReleaseReadApi } from "./read-api.js";

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export interface OracleReadApiServerOptions {
  readonly handler: OracleReleaseReadApi;
  readonly host: string;
}

export function createOracleReadApiServer(options: OracleReadApiServerOptions): Server {
  if (!ALLOWED_LOOPBACK_HOSTS.has(options.host)) {
    throw new Error("Oracle read API server must bind to an explicit loopback address.");
  }
  const server = createServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      void dispatch(request, response, options.handler, options.host);
    },
  );
  server.maxHeadersCount = 32;
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function dispatch(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: OracleReleaseReadApi,
  host: string,
): Promise<void> {
  try {
    const headers = new Headers();
    const raw = incoming.rawHeaders;
    if (raw.length > 64) {
      outgoing.writeHead(431, { "cache-control": "no-store" }).end();
      return;
    }
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const name = raw[index];
      const value = raw[index + 1];
      if (name && value) headers.append(name, value);
    }
    const method = incoming.method ?? "GET";
    const pathname = incoming.url ?? "/";
    if (pathname.length > 8 * 1024) {
      incoming.resume();
      outgoing.writeHead(414, { "cache-control": "no-store", connection: "close" }).end();
      return;
    }
    const contentLength = incoming.headers["content-length"];
    const hasBody = incoming.headers["transfer-encoding"] !== undefined ||
      (contentLength !== undefined && contentLength !== "0");
    if (method !== "GET" || hasBody) {
      incoming.resume();
      outgoing.writeHead(method === "GET" ? 400 : 405, {
        "cache-control": "no-store",
        connection: "close",
        ...(method === "GET" ? {} : { allow: "GET" }),
      }).end();
      return;
    }
    const request = new Request(`http://${host}${pathname}`, { method, headers });
    const result = await handler(request);
    const body = new Uint8Array(await result.arrayBuffer());
    const responseHeaders = new Headers(result.headers);
    responseHeaders.delete("content-length");
    const entries = [...responseHeaders.entries()];
    outgoing.writeHead(result.status, entries);
    outgoing.end(body);
  } catch {
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
    }
    outgoing.end(JSON.stringify({ error: "internal_error" }));
  }
}
