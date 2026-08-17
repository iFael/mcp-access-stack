import { DurableObject } from "cloudflare:workers";
import {
  EDGE_PROTOCOL_VERSION,
  EDGE_RELAY_TIMEOUT_MS,
  MAX_EDGE_REQUEST_BODY_BYTES,
  MAX_EDGE_RESPONSE_BODY_BYTES,
  collectAllowedRequestHeaders,
  collectAllowedResponseHeaders,
  isAllowedEdgeRequest,
  jsonResponse,
  parseConnectorToEdgeMessage,
  utf8ByteLength,
  type EdgeHelloMessage,
  type EdgeHttpCancelMessage,
  type EdgeHttpRequestMessage,
} from "./protocol.js";

export type EdgeGatewayEnv = {
  MCP_SESSION: DurableObjectNamespace<McpSession>;
  MCP_EDGE_ENABLED?: string;
  MCP_CONNECTOR_TOKEN?: string;
};

type ConnectorAttachment = {
  role: "connector";
  ready: boolean;
  protocolVersion: number;
};

type PendingRelay = {
  resolve: (response: Response) => void;
  timeout: ReturnType<typeof setTimeout>;
  releaseAbort: () => void;
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
    if (url.pathname === "/status") {
      return jsonResponse({ connectorReady: this.getReadyConnector() !== null });
    }
    if (isAllowedEdgeRequest(request.method, `${url.pathname}${url.search}`)) {
      return this.handleHttpRequest(request);
    }

    return jsonResponse({ error: "not_found" }, 404);
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      webSocket.close(1003, "Text messages only");
      return;
    }

    const parsed = parseConnectorToEdgeMessage(message);
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
    pending.releaseAbort();

    if (utf8ByteLength(parsed.body) > MAX_EDGE_RESPONSE_BODY_BYTES) {
      pending.resolve(jsonResponse({ error: "connector_response_too_large" }, 502));
      return;
    }

    const headers = collectAllowedResponseHeaders(parsed.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    headers.set("cache-control", "no-store");

    pending.resolve(new Response(parsed.body, { status: parsed.status, headers }));
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

  private async handleHttpRequest(request: Request): Promise<Response> {
    const connector = this.getReadyConnector();
    if (!connector) {
      return jsonResponse({ error: "connector_unavailable" }, 503);
    }

    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    if (!isAllowedEdgeRequest(request.method, path)) {
      return jsonResponse({ error: "edge_route_not_allowed" }, 404);
    }

    const body = request.method === "GET" ? "" : await request.text();
    if (utf8ByteLength(body) > MAX_EDGE_REQUEST_BODY_BYTES) {
      return jsonResponse({ error: "request_too_large" }, 413);
    }

    const requestId = crypto.randomUUID();
    const envelope: EdgeHttpRequestMessage = {
      type: "http-request",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId,
      method: request.method as EdgeHttpRequestMessage["method"],
      path,
      headers: collectAllowedRequestHeaders(request.headers),
      body,
    };

    return new Promise<Response>((resolve) => {
      const finishWithCancellation = (
        reason: EdgeHttpCancelMessage["reason"],
        response: Response,
      ) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.releaseAbort();
        this.sendCancellation(connector, requestId, reason);
        resolve(response);
      };

      const timeout = setTimeout(() => {
        finishWithCancellation("timeout", jsonResponse({ error: "connector_timeout" }, 504));
      }, EDGE_RELAY_TIMEOUT_MS);

      const onAbort = () => {
        finishWithCancellation("client_disconnected", new Response(null, { status: 499 }));
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      const releaseAbort = () => request.signal.removeEventListener("abort", onAbort);

      this.pending.set(requestId, { resolve, timeout, releaseAbort });

      try {
        connector.send(JSON.stringify(envelope));
      } catch {
        clearTimeout(timeout);
        releaseAbort();
        this.pending.delete(requestId);
        resolve(jsonResponse({ error: "connector_send_failed" }, 503));
      }
    });
  }

  private sendCancellation(
    connector: WebSocket,
    requestId: string,
    reason: EdgeHttpCancelMessage["reason"],
  ): void {
    if (connector.readyState !== WebSocket.OPEN) return;
    const cancellation: EdgeHttpCancelMessage = {
      type: "http-cancel",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId,
      reason,
    };
    try {
      connector.send(JSON.stringify(cancellation));
    } catch {
      // The relay is already completing fail-closed; a cancellation send failure is non-fatal here.
    }
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
      pending.releaseAbort();
      pending.resolve(jsonResponse({ error: reason }, 503));
      this.pending.delete(requestId);
    }
  }
}
