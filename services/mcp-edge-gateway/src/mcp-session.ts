import { DurableObject } from "cloudflare:workers";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol/source";
import { EdgeAuthenticationError } from "./control-plane/auth.js";
import { EdgeOwnerOAuth } from "./control-plane/owner-oauth.js";
import {
  ConnectorTelemetryStore,
  type ConnectorTelemetryEvent,
  type EdgeRuntimeTelemetryV1,
} from "./connector-telemetry.js";
import {
  appendSessionDiagnostic,
  classifySessionDiagnostic,
  readSessionDiagnostics,
  shouldPersistSessionDiagnostic,
} from "./control-plane/session-diagnostics.js";
import {
  EdgeControlPlaneConfigurationError,
  createEdgeControlPlaneRuntime,
  type EdgeControlPlaneEnv,
  type EdgeControlPlaneRuntime,
} from "./control-plane/runtime.js";
import {
  EDGE_PROTOCOL_VERSION,
  LEGACY_EDGE_PROTOCOL_VERSION,
  EDGE_RELAY_TIMEOUT_MS,
  MAX_EDGE_REQUEST_BODY_BYTES,
  MAX_EDGE_RESPONSE_BODY_BYTES,
  collectAllowedRequestHeaders,
  collectLegacyAllowedRequestHeaders,
  collectAllowedResponseHeaders,
  isAllowedEdgeRequest,
  jsonResponse,
  parseConnectorToEdgeMessage,
  parseLegacyConnectorToEdgeMessage,
  resolveConnectorProtocol,
  utf8ByteLength,
  type EdgeHttpCancelMessage,
  type EdgeHttpRequestMessage,
} from "./protocol.js";

export type EdgeGatewayEnv = EdgeControlPlaneEnv & {
  MCP_SESSION: DurableObjectNamespace<McpSession>;
  MCP_EDGE_ENABLED?: string;
  MCP_CONNECTOR_TOKEN?: string;
};

type ConnectorAttachment = {
  role: "connector";
  ready: boolean;
  protocolVersion: number;
  connectionGeneration?: number;
  disconnectRecorded?: boolean;
};

type PendingRelay = {
  resolve: (response: Response) => void;
  timeout: ReturnType<typeof setTimeout>;
  releaseAbort: () => void;
  unavailableResponse?: (() => Response) | undefined;
};

export class McpSession extends DurableObject<EdgeGatewayEnv> {
  private readonly pending = new Map<string, PendingRelay>();
  private readonly connectorTelemetry: ConnectorTelemetryStore;
  private controlRuntime: EdgeControlPlaneRuntime | undefined;
  private v3CutoverComplete = false;

  constructor(ctx: DurableObjectState, private readonly edgeEnv: EdgeGatewayEnv) {
    super(ctx, edgeEnv);
    this.connectorTelemetry = new ConnectorTelemetryStore(this.ctx.storage);
  }

  async getStatus(): Promise<{
    controlPlaneReady: boolean;
    executionPlaneReady: boolean;
    connectorReady: boolean;
    runtimeTelemetry: EdgeRuntimeTelemetryV1;
  }> {
    const connector = this.getReadyConnector();
    const connectorReady = connector !== null;
    const attachment = connector ? this.readConnectorAttachment(connector) : null;
    let controlPlaneReady = attachment?.protocolVersion === LEGACY_EDGE_PROTOCOL_VERSION;
    if (!controlPlaneReady) {
      try {
        const runtime = this.getControlRuntime();
        controlPlaneReady = runtime.oauth instanceof EdgeOwnerOAuth
          ? await runtime.oauth.isConfigured()
          : true;
      } catch (error) {
        if (!(error instanceof EdgeControlPlaneConfigurationError)) throw error;
      }
    }
    return {
      controlPlaneReady,
      executionPlaneReady: controlPlaneReady && connectorReady,
      connectorReady,
      runtimeTelemetry: await this.connectorTelemetry.read(),
    };
  }

  async getSessionDiagnostics(): Promise<string> {
    return JSON.stringify({ version: 1, events: await readSessionDiagnostics(this.ctx.storage) });
  }

  async getRuntimeTelemetry(): Promise<EdgeRuntimeTelemetryV1> {
    return this.connectorTelemetry.read();
  }

  async bootstrapLegacyOwnerState(input: unknown): Promise<string> {
    const result = await this.bootstrapLegacyOwnerStateResult(input);
    return JSON.stringify(result);
  }

  private async bootstrapLegacyOwnerStateResult(input: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!isRecord(input) || Object.keys(input).sort().join(",") !== "ownerToken,state" ||
        typeof input.ownerToken !== "string") {
      return { status: 400, body: { error: "invalid_owner_bootstrap" } };
    }
    let runtime: EdgeControlPlaneRuntime;
    try {
      runtime = this.getControlRuntime();
    } catch (error) {
      if (error instanceof EdgeControlPlaneConfigurationError) {
        return { status: 503, body: { error: "edge_control_plane_not_configured" } };
      }
      throw error;
    }
    if (!(runtime.oauth instanceof EdgeOwnerOAuth)) {
      return { status: 409, body: { error: "owner_bootstrap_not_applicable" } };
    }
    try {
      await runtime.oauth.bootstrapLegacyState(input.state, input.ownerToken);
      return { status: 200, body: { status: "bootstrapped" } };
    } catch (error) {
      const alreadyBootstrapped = error instanceof Error && /already bootstrapped/u.test(error.message);
      return {
        status: alreadyBootstrapped ? 409 : 400,
        body: { error: alreadyBootstrapped ? "owner_bootstrap_already_complete" : "owner_bootstrap_rejected" },
      };
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connector") {
      return this.handleConnectorUpgrade(request);
    }
    if (url.pathname === "/status") {
      return jsonResponse(await this.getStatus());
    }
    if (isAllowedEdgeRequest(request.method, `${url.pathname}${url.search}`)) {
      return this.handleAllowedRequest(request);
    }

    return jsonResponse({ error: "not_found" }, 404);
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      webSocket.close(1003, "Text messages only");
      return;
    }

    const attachment = this.readConnectorAttachment(webSocket);
    if (!attachment) {
      webSocket.close(1008, "Invalid connector session");
      return;
    }
    const parsed = attachment.protocolVersion === LEGACY_EDGE_PROTOCOL_VERSION
      ? parseLegacyConnectorToEdgeMessage(message)
      : parseConnectorToEdgeMessage(message);
    if (!parsed || parsed.protocolVersion !== attachment.protocolVersion) {
      webSocket.close(1008, "Invalid connector message");
      return;
    }

    if (parsed.type === "connector-ready") {
      const runtime = "runtime" in parsed ? parsed.runtime : undefined;
      webSocket.serializeAttachment({
        role: "connector",
        ready: true,
        protocolVersion: attachment.protocolVersion,
        disconnectRecorded: false,
        ...(runtime === undefined ? {} : { connectionGeneration: runtime.connectionGeneration }),
      } satisfies ConnectorAttachment);
      this.updateConnectorTelemetry({
        type: "ready",
        at: new Date().toISOString(),
        ...(runtime === undefined ? {} : { runtime }),
      });
      if (attachment.protocolVersion === EDGE_PROTOCOL_VERSION) {
        this.v3CutoverComplete = true;
        this.ctx.waitUntil(this.ctx.storage.put("edge:v3-cutover-complete", true));
      }
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

    if (attachment.protocolVersion === EDGE_PROTOCOL_VERSION) {
      this.updateConnectorTelemetry({
        type: "response",
        at: new Date().toISOString(),
        requestId: parsed.requestId,
      });
    }

    const headers = collectAllowedResponseHeaders(parsed.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    headers.set("cache-control", "no-store");

    pending.resolve(new Response(parsed.body, { status: parsed.status, headers }));
  }

  override webSocketClose(webSocket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.recordConnectorDisconnect(webSocket);
    if (this.getReadyConnector() === null) {
      this.failPendingRequests("connector_disconnected");
    }
  }

  override webSocketError(webSocket: WebSocket, _error: unknown): void {
    this.recordConnectorDisconnect(webSocket);
    if (this.getReadyConnector() === null) {
      this.failPendingRequests("connector_error");
    }
  }

  private async handleAllowedRequest(request: Request): Promise<Response> {
    const legacyConnector = this.getReadyConnector(LEGACY_EDGE_PROTOCOL_VERSION);
    if (legacyConnector) return this.relayLegacyRequest(request, legacyConnector);

    let runtime: EdgeControlPlaneRuntime;
    try {
      runtime = this.getControlRuntime();
    } catch (error) {
      if (error instanceof EdgeControlPlaneConfigurationError) {
        return jsonResponse({ error: "edge_control_plane_not_configured" }, 503);
      }
      throw error;
    }

    const diagnosticRequest = request.clone();
    const localResponse = await runtime.router.route(request);
    if (localResponse) {
      await this.recordSessionDiagnostic(diagnosticRequest, localResponse.clone());
      return localResponse;
    }

    const url = new URL(request.url);
    if (url.pathname === "/mcp" && (request.method === "GET" || request.method === "DELETE")) {
      let principal: AuthenticatedEdgePrincipal;
      try {
        principal = await runtime.authenticator.authenticate(request);
      } catch (error) {
        if (error instanceof EdgeAuthenticationError) {
          const response = error.toResponse();
          await this.recordSessionDiagnostic(request.clone(), response.clone());
          return response;
        }
        throw error;
      }
      const diagnosticRequest = request.clone();
      const response = await this.relayAuthenticatedRequest(request, "", principal);
      await this.recordSessionDiagnostic(diagnosticRequest, response.clone());
      return response;
    }

    return jsonResponse({ error: "edge_route_not_allowed" }, 404);
  }

  private async recordSessionDiagnostic(
    request: Parameters<typeof classifySessionDiagnostic>[0],
    response: Parameters<typeof classifySessionDiagnostic>[1],
  ): Promise<void> {
    try {
      const event = await classifySessionDiagnostic(request, response);
      if (!shouldPersistSessionDiagnostic(event)) return;
      await appendSessionDiagnostic(this.ctx.storage, event);
      console.log(JSON.stringify({ event: "mcp_session_diagnostic", ...event }));
    } catch {
      console.warn(JSON.stringify({ event: "mcp_session_diagnostic_failed" }));
    }
  }

  private getControlRuntime(): EdgeControlPlaneRuntime {
    this.controlRuntime ??= createEdgeControlPlaneRuntime(
      this.edgeEnv,
      this.ctx.storage,
      {
        isReady: () => this.getReadyConnector(EDGE_PROTOCOL_VERSION) !== null,
        getGeneration: () => this.getReadyConnectorGeneration(),
        execute: async (body, principal, request) => {
          if (!request) return agentUnavailableResponse(body);
          return this.relayAuthenticatedRequest(
            request,
            JSON.stringify(body),
            principal,
            () => agentUnavailableResponse(body),
          );
        },
      },
    );
    return this.controlRuntime;
  }

  private async handleConnectorUpgrade(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_required" }, 426);
    }
    const persistedCutover = this.v3CutoverComplete ||
      (await this.ctx.storage.get<boolean>("edge:v3-cutover-complete")) === true;
    if (persistedCutover) this.v3CutoverComplete = true;
    const protocolVersion = resolveConnectorProtocol(new URL(request.url), persistedCutover);
    if (protocolVersion === null) {
      return jsonResponse({ error: "connector_protocol_not_allowed" }, 409);
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
      protocolVersion,
      disconnectRecorded: false,
    } satisfies ConnectorAttachment);
    this.ctx.acceptWebSocket(server, ["connector"]);
    server.send(JSON.stringify({ type: "edge-hello", protocolVersion }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async relayLegacyRequest(request: Request, connector: WebSocket): Promise<Response> {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    if (!isAllowedEdgeRequest(request.method, path)) return jsonResponse({ error: "edge_route_not_allowed" }, 404);
    const body = request.method === "GET" ? "" : await request.text();
    if (utf8ByteLength(body) > MAX_EDGE_REQUEST_BODY_BYTES) return jsonResponse({ error: "request_too_large" }, 413);
    const requestId = crypto.randomUUID();
    const envelope = {
      type: "http-request",
      protocolVersion: LEGACY_EDGE_PROTOCOL_VERSION,
      requestId,
      method: request.method,
      path,
      headers: collectLegacyAllowedRequestHeaders(request.headers),
      body,
    };
    return new Promise<Response>((resolve) => {
      const finish = (reason: EdgeHttpCancelMessage["reason"], response: Response) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.releaseAbort();
        this.sendCancellation(connector, requestId, reason, LEGACY_EDGE_PROTOCOL_VERSION);
        resolve(response);
      };
      const timeout = setTimeout(() => finish("timeout", jsonResponse({ error: "connector_timeout" }, 504)), EDGE_RELAY_TIMEOUT_MS);
      const onAbort = () => finish("client_disconnected", new Response(null, { status: 499 }));
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

  private async relayAuthenticatedRequest(
    request: Request,
    body: string,
    principal: AuthenticatedEdgePrincipal,
    unavailableResponse?: () => Response,
  ): Promise<Response> {
    const connector = this.getReadyConnector(EDGE_PROTOCOL_VERSION);
    if (!connector) {
      return unavailableResponse?.() ?? jsonResponse({ error: "connector_unavailable" }, 503);
    }

    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    if (!isAllowedEdgeRequest(request.method, path)) {
      return jsonResponse({ error: "edge_route_not_allowed" }, 404);
    }

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
      principal,
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
        this.sendCancellation(connector, requestId, reason, EDGE_PROTOCOL_VERSION);
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

      this.pending.set(requestId, {
        resolve,
        timeout,
        releaseAbort,
        ...(unavailableResponse === undefined ? {} : { unavailableResponse }),
      });

      this.updateConnectorTelemetry({
        type: "request",
        at: new Date().toISOString(),
        requestId,
      });
      try {
        connector.send(JSON.stringify(envelope));
      } catch {
        clearTimeout(timeout);
        releaseAbort();
        this.pending.delete(requestId);
        resolve(unavailableResponse?.() ?? jsonResponse({ error: "connector_send_failed" }, 503));
      }
    });
  }

  private sendCancellation(
    connector: WebSocket,
    requestId: string,
    reason: EdgeHttpCancelMessage["reason"],
    protocolVersion: 2 | 3,
  ): void {
    if (connector.readyState !== WebSocket.OPEN) return;
    const cancellation = {
      type: "http-cancel",
      protocolVersion,
      requestId,
      reason,
    };
    try {
      connector.send(JSON.stringify(cancellation));
    } catch {
      // The relay is already completing fail-closed; a cancellation send failure is non-fatal here.
    }
  }

  private getReadyConnector(protocolVersion?: number): WebSocket | null {
    for (const webSocket of this.ctx.getWebSockets("connector")) {
      const attachment = this.readConnectorAttachment(webSocket);
      if (
        attachment?.ready === true &&
        (protocolVersion === undefined || attachment.protocolVersion === protocolVersion) &&
        webSocket.readyState === WebSocket.OPEN
      ) return webSocket;
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

    if (
      "connectionGeneration" in attachment &&
      attachment.connectionGeneration !== undefined &&
      (typeof attachment.connectionGeneration !== "number" ||
        !Number.isSafeInteger(attachment.connectionGeneration) ||
        attachment.connectionGeneration <= 0)
    ) return null;
    if (
      "disconnectRecorded" in attachment &&
      attachment.disconnectRecorded !== undefined &&
      typeof attachment.disconnectRecorded !== "boolean"
    ) return null;

    return {
      role: "connector",
      ready: attachment.ready,
      protocolVersion: attachment.protocolVersion,
      ...("connectionGeneration" in attachment && attachment.connectionGeneration !== undefined
        ? { connectionGeneration: attachment.connectionGeneration as number }
        : {}),
      ...("disconnectRecorded" in attachment && attachment.disconnectRecorded !== undefined
        ? { disconnectRecorded: attachment.disconnectRecorded as boolean }
        : {}),
    };
  }

  private getReadyConnectorGeneration(): number | null {
    const connector = this.getReadyConnector(EDGE_PROTOCOL_VERSION);
    if (!connector) return null;
    return this.readConnectorAttachment(connector)?.connectionGeneration ?? null;
  }

  private updateConnectorTelemetry(event: ConnectorTelemetryEvent): void {
    this.ctx.waitUntil(this.connectorTelemetry.record(event).then(() => undefined));
  }

  private recordConnectorDisconnect(webSocket: WebSocket): void {
    const attachment = this.readConnectorAttachment(webSocket);
    if (!attachment || attachment.disconnectRecorded === true) return;
    webSocket.serializeAttachment({
      ...attachment,
      ready: false,
      disconnectRecorded: true,
    } satisfies ConnectorAttachment);
    this.updateConnectorTelemetry({
      type: "disconnected",
      at: new Date().toISOString(),
    });
  }

  private failPendingRequests(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.releaseAbort();
      pending.resolve(pending.unavailableResponse?.() ?? jsonResponse({ error: reason }, 503));
      this.pending.delete(requestId);
    }
  }
}

function agentUnavailableResponse(body: unknown): Response {
  const id = readJsonRpcId(body);
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32001,
      message: "Execution backend unavailable",
      data: { code: "AGENT_UNAVAILABLE" },
    },
  });
}

function readJsonRpcId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
