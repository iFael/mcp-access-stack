import { createServer, request as httpRequest, type Server } from "node:http";
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  BrowserNetworkGuardProxy,
  type BrowserNetworkGuardCredentials,
} from "../../drivers/direct/browser-network-guard-proxy.js";

const servers: Server[] = [];
const guards: BrowserNetworkGuardProxy[] = [];
const netServers: NetServer[] = [];

afterEach(async () => {
  await Promise.all(guards.splice(0).map((guard) => guard.stop()));
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(netServers.splice(0).map((server) => closeNetServer(server)));
});

describe("BrowserNetworkGuardProxy", () => {
  it("requires proxy authentication and keeps private hosts quarantined until released", async () => {
    let requests = 0;
    const target = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    servers.push(target);
    const targetPort = await listen(target);
    const guard = new BrowserNetworkGuardProxy({
      privateOrigins: ["http://127.0.0.1"],
      deniedOrigins: ["http://localhost"],
    });
    guards.push(guard);
    const proxyUrl = await guard.start();
    const credentials = guard.credentials();
    const targetUrl = new URL(`http://127.0.0.1:${targetPort}/private`);

    await expect(proxyRequest(proxyUrl, targetUrl)).resolves.toMatchObject({
      status: 407,
    });
    expect(requests).toBe(0);

    guard.enableOrigin(targetUrl.origin);
    await expect(
      proxyRequest(proxyUrl, targetUrl, credentials),
    ).resolves.toMatchObject({ status: 403 });
    expect(requests).toBe(0);

    guard.endQuarantine();
    await expect(proxyRequest(proxyUrl, targetUrl, credentials)).resolves.toEqual({
      status: 200,
      body: "ok",
    });
    expect(requests).toBe(1);

    await expect(
      connectStatus(proxyUrl, `127.0.0.1:${targetPort}`, credentials),
    ).resolves.toBe(200);

    guard.beginQuarantine();
    await expect(
      proxyRequest(proxyUrl, targetUrl, credentials),
    ).resolves.toMatchObject({ status: 403 });
    expect(requests).toBe(1);
  });

  it("survives an abrupt CONNECT upstream reset and remains usable", async () => {
    const resetTarget = createNetServer((socket) => {
      socket.on("error", () => undefined);
      setTimeout(() => socket.destroy(new Error("forced reset")), 20);
    });
    netServers.push(resetTarget);
    const resetPort = await listenNet(resetTarget);

    const healthyTarget = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("healthy");
    });
    servers.push(healthyTarget);
    const healthyPort = await listen(healthyTarget);

    const guard = new BrowserNetworkGuardProxy({
      privateOrigins: ["http://127.0.0.1"],
      deniedOrigins: [],
    });
    guards.push(guard);
    const proxyUrl = await guard.start();
    const credentials = guard.credentials();
    guard.enableOrigin("http://127.0.0.1");
    guard.endQuarantine();

    await expect(
      connectUntilClosed(proxyUrl, `127.0.0.1:${resetPort}`, credentials),
    ).resolves.toBe(200);

    await expect(proxyRequest(
      proxyUrl,
      new URL(`http://127.0.0.1:${healthyPort}/after-reset`),
      credentials,
    )).resolves.toEqual({ status: 200, body: "healthy" });
  });

  it("contains a late accepted-socket reset during parser failure", async () => {
    const guard = new BrowserNetworkGuardProxy({
      privateOrigins: [],
      deniedOrigins: [],
    });
    guards.push(guard);
    await guard.start();

    const server = (guard as unknown as { server?: Server }).server;
    if (!server) throw new Error("Expected proxy server.");
    const clientError = server.listeners("clientError")[0] as (
      error: Error,
      socket: Socket,
    ) => void;
    const socket = new PassThrough() as unknown as Socket;
    const destroy = socket.destroy.bind(socket);
    socket.destroy = ((error?: Error) => {
      const result = destroy(error);
      const reset = Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      });
      socket.emit("error", reset);
      return result;
    }) as typeof socket.destroy;

    expect(() => clientError(new Error("parse failure"), socket)).not.toThrow();
  });
  it("enforces grant expiry and permanent denied-host precedence", async () => {
    let requests = 0;
    const target = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    servers.push(target);
    const targetPort = await listen(target);
    const guard = new BrowserNetworkGuardProxy({
      privateOrigins: ["http://127.0.0.1", "http://localhost"],
      deniedOrigins: ["http://localhost"],
    });
    guards.push(guard);
    const proxyUrl = await guard.start();
    const credentials = guard.credentials();
    guard.endQuarantine();

    const privateUrl = new URL(`http://127.0.0.1:${targetPort}/private`);
    guard.enableOrigin(privateUrl.origin, "2000-01-01T00:00:00.000Z");
    await expect(
      proxyRequest(proxyUrl, privateUrl, credentials),
    ).resolves.toMatchObject({ status: 403 });
    expect(guard.isOriginEnabled(privateUrl.origin)).toBe(false);

    const deniedUrl = new URL(`http://localhost:${targetPort}/production`);
    guard.enableOrigin(deniedUrl.origin, "2099-01-01T00:00:00.000Z");
    await expect(
      proxyRequest(proxyUrl, deniedUrl, credentials),
    ).resolves.toMatchObject({ status: 403 });
    expect(requests).toBe(0);
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listenNet(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return address.port;
}

async function closeNetServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function proxyRequest(
  proxyUrl: URL,
  targetUrl: URL,
  credentials?: BrowserNetworkGuardCredentials,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      method: "GET",
      path: targetUrl.href,
      headers: {
        host: targetUrl.host,
        ...(credentials
          ? { "proxy-authorization": authorization(credentials) }
          : {}),
      },
    });
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function connectStatus(
  proxyUrl: URL,
  authority: string,
  credentials: BrowserNetworkGuardCredentials,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(Number(proxyUrl.port), proxyUrl.hostname);
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\n` +
          `Host: ${authority}\r\n` +
          `Proxy-Authorization: ${authorization(credentials)}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\r\n\r\n")) return;
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(buffer)?.[1] ?? 0);
      socket.destroy();
      resolve(status);
    });
  });
}

async function connectUntilClosed(
  proxyUrl: URL,
  authority: string,
  credentials: BrowserNetworkGuardCredentials,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(Number(proxyUrl.port), proxyUrl.hostname);
    let status = 0;
    let buffer = "";
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\n` +
          `Host: ${authority}\r\n` +
          `Proxy-Authorization: ${authorization(credentials)}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (status === 0 && buffer.includes("\r\n\r\n")) {
        status = Number(/^HTTP\/1\.1 (\d+)/.exec(buffer)?.[1] ?? 0);
        socket.write("probe");
      }
    });
    socket.once("error", () => {
      if (status > 0) resolve(status);
      else reject(new Error("CONNECT failed before the proxy response."));
    });
    socket.once("close", () => {
      if (status > 0) resolve(status);
      else reject(new Error("CONNECT closed before the proxy response."));
    });
  });
}

function authorization(credentials: BrowserNetworkGuardCredentials): string {
  return `Basic ${Buffer.from(
    `${credentials.username}:${credentials.password}`,
    "utf8",
  ).toString("base64")}`;
}
