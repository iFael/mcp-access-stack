import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface BrowserWorkerHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export function createBrowserWorkerHttpServer(
  handler: BrowserWorkerHttpHandler,
): Server {
  const server = createServer((request, response) => {
    response.on("error", () => {
      if (!response.destroyed) response.destroy();
    });
    void handler.handle(request, response).catch(() => {
      if (!response.destroyed) response.destroy();
    });
  });

  server.on("connection", (socket) => {
    socket.on("error", () => {
      if (!socket.destroyed) socket.destroy();
    });
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.destroy();
  });

  return server;
}
