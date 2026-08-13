import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";
import { pipeline, type Duplex } from "node:stream";
import { AppError } from "@vs-code-gpt/shared";

export interface BrowserNetworkGuardProxyOptions {
  privateOrigins: readonly string[];
  deniedOrigins: readonly string[];
}

export interface BrowserNetworkGuardCredentials {
  username: string;
  password: string;
}

export class BrowserNetworkGuardProxy {
  private readonly privateHosts: Set<string>;
  private readonly deniedHosts: Set<string>;
  private readonly enabledPrivateHosts = new Map<string, number>();
  private readonly username = "mcp";
  private readonly password = randomBytes(32).toString("base64url");
  private readonly authorizationHeader: string;
  private server: Server | undefined;
  private proxyUrl: URL | undefined;
  private quarantined = true;

  constructor(options: BrowserNetworkGuardProxyOptions) {
    this.privateHosts = new Set(options.privateOrigins.map(originHost));
    this.deniedHosts = new Set(options.deniedOrigins.map(originHost));
    this.authorizationHeader = `Basic ${Buffer.from(
      `${this.username}:${this.password}`,
      "utf8",
    ).toString("base64")}`;
  }

  credentials(): BrowserNetworkGuardCredentials {
    return { username: this.username, password: this.password };
  }

  beginQuarantine(): void {
    this.quarantined = true;
  }

  endQuarantine(): void {
    this.quarantined = false;
  }

  async start(): Promise<URL> {
    if (this.proxyUrl) return new URL(this.proxyUrl.href);
    const guardedSockets = new WeakSet<Duplex>();
    const guardSocket = (socket: Duplex): void => {
      if (guardedSockets.has(socket)) return;
      guardedSockets.add(socket);
      socket.on("error", () => {
        if (!socket.destroyed) socket.destroy();
      });
    };
    const server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    server.on("connection", guardSocket);
    server.on("connect", (request, client, head) => {
      guardSocket(client);
      this.handleConnect(request, client, head);
    });
    server.on("clientError", (_error, socket) => {
      guardSocket(socket);
      if (!socket.destroyed) socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new AppError(
        "BROWSER_WORKER_UNAVAILABLE",
        "The browser network guard could not acquire a loopback port.",
      );
    }
    this.server = server;
    this.proxyUrl = new URL(`http://127.0.0.1:${address.port}`);
    return new URL(this.proxyUrl.href);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.proxyUrl = undefined;
    this.enabledPrivateHosts.clear();
    this.quarantined = true;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  enableOrigin(origin: string, expiresAt?: string): void {
    const host = originHost(origin);
    if (!this.privateHosts.has(host) || this.deniedHosts.has(host)) return;
    const expiry = expiresAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(expiresAt);
    if (!Number.isFinite(expiry) && expiry !== Number.POSITIVE_INFINITY) return;
    this.enabledPrivateHosts.set(host, expiry);
  }

  disableOrigin(origin: string): void {
    this.enabledPrivateHosts.delete(originHost(origin));
  }

  isOriginEnabled(origin: string, now = Date.now()): boolean {
    return this.isPrivateHostEnabled(originHost(origin), now);
  }

  private handleConnect(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): void {
    if (!this.isAuthenticated(request)) {
      client.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="mcp-browser"\r\n' +
          "Connection: close\r\n\r\n",
      );
      return;
    }
    const target = parseAuthority(request.url);
    if (!target || !this.isHostAllowed(target.hostname)) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = netConnect(target.port, target.hostname);
    let closing = false;
    const closePair = (): void => {
      if (closing) return;
      closing = true;
      if (!upstream.destroyed) upstream.destroy();
      if (!client.destroyed) client.destroy();
    };
    upstream.on("error", closePair);
    client.on("error", closePair);
    upstream.once("close", () => {
      if (!client.destroyed) client.destroy();
    });
    client.once("close", () => {
      if (!upstream.destroyed) upstream.destroy();
    });
    upstream.once("connect", () => {
      if (client.destroyed || upstream.destroyed) {
        closePair();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.isAuthenticated(request)) {
      response.writeHead(407, {
        connection: "close",
        "proxy-authenticate": 'Basic realm="mcp-browser"',
      });
      response.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400, { connection: "close" });
      response.end();
      return;
    }
    if (target.protocol !== "http:" || !this.isHostAllowed(target.hostname)) {
      response.writeHead(403, { connection: "close" });
      response.end();
      return;
    }
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
    });
    const failHttp = (): void => {
      if (!upstream.destroyed) upstream.destroy();
      if (!response.headersSent) response.writeHead(502, { connection: "close" });
      if (!response.writableEnded) response.end();
    };
    upstream.on("error", failHttp);
    request.on("error", failHttp);
    response.on("error", () => {
      if (!upstream.destroyed) upstream.destroy();
      if (!request.destroyed) request.destroy();
    });
    upstream.once("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      pipeline(upstreamResponse, response, () => undefined);
    });
    pipeline(request, upstream, (error) => {
      if (error) failHttp();
    });
  }

  private isAuthenticated(request: IncomingMessage): boolean {
    const raw = request.headers["proxy-authorization"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return false;
    const actual = Buffer.from(value, "utf8");
    const expected = Buffer.from(this.authorizationHeader, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private isHostAllowed(value: string): boolean {
    const host = normalizeHost(value);
    if (this.deniedHosts.has(host)) return false;
    if (!this.privateHosts.has(host)) return true;
    return this.isPrivateHostEnabled(host, Date.now());
  }

  private isPrivateHostEnabled(host: string, now: number): boolean {
    if (this.quarantined) return false;
    const expiresAt = this.enabledPrivateHosts.get(host);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.enabledPrivateHosts.delete(host);
      return false;
    }
    return true;
  }
}

function originHost(origin: string): string {
  return normalizeHost(new URL(origin).hostname);
}

function normalizeHost(value: string): string {
  return value
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLocaleLowerCase("en-US");
}

function parseAuthority(
  value: string | undefined,
): { hostname: string; port: number } | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(`http://${value}`);
    const port = Number(url.port || 443);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
    return { hostname: normalizeHost(url.hostname), port };
  } catch {
    return undefined;
  }
}
