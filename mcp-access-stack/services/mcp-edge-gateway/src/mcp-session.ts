import { DurableObject } from "cloudflare:workers";
import {
  EDGE_PROTOCOL_VERSION,
  MAX_MCP_REQUEST_BODY_BYTES,
  MAX_MCP_RESPONSE_BODY_BYTES,
  MCP_RELAY_TIMEOUT_MS,
  collectAllowedRequestHeaders,
  collectAllowedResponseHeaders,
  jsonResponse,
  parseConnectorMessage,
  utf8ByteLength,
  type ConnectorAttachment,
  type EdgeHelloMessage,
  type McpRequestMessage,
} from "./protocol.js";

export type EdgeGatewayEnv = {
  MCP_SESSION: DurableObjectNamespace<McpSession>;
  MCP_EDGE_ENABLED?: string;
  MCP_CONNECTOR_TOKEN?: string;
};

type PendingRelay = {
  resolve: (response: Response) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class McpSession extends DurableObject<EdgeGatewayEnv> {
  private readonly pending = new Map<string, PendingRelay>();

  constructor(ctx: DurableObjectState, env: EdgeGatewayEnv) {
    super(ctx, env);
  }

  getStatus(): { connectorReady: boolean } {
    return { connectorReady: this.getReadyConnector() !== null };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connector") {
      return this.handleConnectorUpgrade(request);
    }
    if (url.pathname === "/mcp") {
      return this.handleMcpRequest(request);
    }
    if (url.pathname === "/status") {
      return jsonResponse({ connectorReady: this.getReadyConnector() !== null });
    }

    return jsonResponse({ error: "not_found" }, 404);
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      webSocket.close(1003, "Text messages only");
      return;
    }

    const parsed = parseConnectorMessage(message);
    if (!parsed) {
      webSocket.close(1008, "Invalid connector message");
      return;
    }

    if (parsed.type === "connector-ready") {
      const attachment = this.readConnectorAttachment(webSocket);
      if (!attachment) {
        webSocket.close(1008, "Invalid connector session");
        return;
      }

      webSocket.serializeAttachment({
        role: "connector",
        ready: true,
        protocolVersion: EDGE_PROTOCOL_VERSION,
      } satisfies ConnectorAttachment);
      return;
    }

    const pending = this.pending.get(parsed.requestId);
    if (!pending) return;

    this.pending.delete(parsed.requestId);
    clearTimeout(pending.timeout);

    if (utf8ByteLength(parsed.body) > MAX_MCP_RESPONSE_BODY_BYTES) {
      pending.resolve(jsonResponse({ error: "connector_response_too_large" }, 502));
      return;
    }

    const headers = collectAllowedResponseHeaders(parsed.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    headers.set("cache-control", "no-store");

    pending.resolve(
      new Response(parsed.body, {
        status: parsed.status,
        headers,
      }),
    );
  }

  override webSocketClose(_webSocket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    if (this.getReadyConnector() === null) {
      this.failPendingRequests("connector_disconnected");
    }
  }

  override webSocketError(_webSocket: WebSocket, _error: unknown): void {
    if (this.getReadyConnector() === null) {
      this.failPendingRequests("connector_error");
    }
  }

  private handleConnectorUpgrade(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_required" }, 426);
    }

    for (const existing of this.ctx.getWebSockets("connector")) {
      existing.close(1012, "Connector replaced");
    }
    this.failPendingRequests("connector_replaced");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({
      role: "connector",
      ready: false,
      protocolVersion: EDGE_PROTOCOL_VERSION,
    } satisfies ConnectorAttachment);
    this.ctx.acceptWebSocket(server, ["connector"]);

    const hello: EdgeHelloMessage = {
      type: "edge-hello",
      protocolVersion: EDGE_PROTOCOL_VERSION,
    };
    server.send(JSON.stringify(hello));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMcpRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }

    const connector = this.getReadyConnector();
    if (!connector) {
      return jsonResponse({ error: "connector_unavailable" }, 503);
    }

    const body = await request.text();
    if (utf8ByteLength(body) > MAX_MCP_REQUEST_BODY_BYTES) {
      return jsonResponse({ error: "request_too_large" }, 413);
    }

    const requestId = crypto.randomUUID();
    const envelope: McpRequestMessage = {
      type: "mcp-request",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId,
      method: "POST",
      headers: collectAllowedRequestHeaders(request.headers),
      body,
    };

    return new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(jsonResponse({ error: "connector_timeout" }, 504));
      }, MCP_RELAY_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, timeout });

      try {
        connector.send(JSON.stringify(envelope));
      } catch {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        resolve(jsonResponse({ error: "connector_send_failed" }, 503));
      }
    });
  }

  private getReadyConnector(): WebSocket | null {
    for (const webSocket of this.ctx.getWebSockets("connector")) {
      const attachment = this.readConnectorAttachment(webSocket);
      if (
        attachment?.ready === true &&
        attachment.protocolVersion === EDGE_PROTOCOL_VERSION &&
        webSocket.readyState === WebSocket.OPEN
      ) {
        return webSocket;
      }
    }
    return null;
  }

  private readConnectorAttachment(webSocket: WebSocket): ConnectorAttachment | null {
    const attachment = webSocket.deserializeAttachment();
    if (
      typeof attachment !== "object" ||
      attachment === null ||
      !("role" in attachment) ||
      attachment.role !== "connector" ||
      !("ready" in attachment) ||
      typeof attachment.ready !== "boolean" ||
      !("protocolVersion" in attachment) ||
      typeof attachment.protocolVersion !== "number"
    ) {
      return null;
    }

    return {
      role: "connector",
      ready: attachment.ready,
      protocolVersion: attachment.protocolVersion,
    };
  }

  private failPendingRequests(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.resolve(jsonResponse({ error: reason }, 503));
      this.pending.delete(requestId);
    }
  }
}
