import { once } from "node:events";
import type { Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "@jest/globals";
import { createBrowserWorkerHttpServer } from "../../infrastructure/browser-worker-http-server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("createBrowserWorkerHttpServer", () => {
  it("survives a socket ECONNRESET and remains available", async () => {
    const server = createBrowserWorkerHttpServer({
      handle: async (_request, response) => {
        response.statusCode = 200;
        response.end("ok");
      },
    });
    servers.push(server);
    const port = await listen(server);
    const acceptedSocket = new Promise<Socket>((resolve) => {
      server.once("connection", resolve);
    });
    const client = netConnect(port, "127.0.0.1");
    await once(client, "connect");
    const socket = await acceptedSocket;

    const reset = Object.assign(new Error("forced reset"), {
      code: "ECONNRESET",
    });
    expect(() => socket.emit("error", reset)).not.toThrow();
    expect(socket.destroyed).toBe(true);
    client.destroy();

    const response = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return address.port;
}
