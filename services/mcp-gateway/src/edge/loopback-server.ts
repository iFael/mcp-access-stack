import { createServer, type Server } from "node:http";
import type { Express } from "express";
import { AppError } from "@vs-code-gpt/shared";

export async function startLoopbackGateway(app: Express): Promise<{
  server: Server;
  baseUrl: URL;
}> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeLoopbackGateway(server);
    throw new AppError(
      "AGENT_UNAVAILABLE",
      "Loopback Gateway did not expose a TCP address.",
    );
  }

  return {
    server,
    baseUrl: new URL(`http://127.0.0.1:${address.port}/`),
  };
}

export function closeLoopbackGateway(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}
