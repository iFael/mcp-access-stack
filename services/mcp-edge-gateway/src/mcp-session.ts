import { DurableObject } from "cloudflare:workers";
import {
  COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL,
  COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL,
  COMPANION_PROTOCOL_VERSION,
  parseCompanionToEdgeMessage,
  type AuthenticatedEdgePrincipal,
  type CompanionHttpRequestMessage,
  type CompanionPlatform,
  type CompanionWorkspace,
  type ConnectorRuntimeIdentity,
} from "@mcp-access-stack/edge-protocol";
import { EdgeAuthenticationError } from "./control-plane/auth.js";
import {
  isCompanionEligibleForUser,
  selectCompanionDevice,
  selectWorkspaceRuntime,
} from "./control-plane/companion-routing.js";
import { EdgeAccountStore, type StoredMaterialization } from "./control-plane/account-store.js";
import { EdgeRepositoryControlPlane } from "./control-plane/repository-control-plane.js";
import {
  EXPECTED_MCP_CONTRACT_REVISION,
  MCP_CONTRACT_ROLLOUT_STORAGE_KEY,
  isConnectorContractCompatible,
  isMcpContractRevision,
  promoteMcpContractRolloutState,
  reconcileMcpContractRolloutState,
  rollbackMcpContractRolloutState,
  type McpContractRolloutStateV1,
} from "./contract-compatibility.js";
import { isPreferredConnectorRuntime, selectPreferredConnectorProtocol } from "./connector-handover.js";
import { EdgeOwnerOAuth } from "./control-plane/owner-oauth.js";
import {
  createAgentUnavailableMcpResponse,
  getMcpResponseDiagnostic,
  type EdgeMcpCatalog,
} from "./control-plane/mcp-control-plane.js";
import {
  persistMcpCatalogSnapshot,
  readMcpCatalogSnapshot,
} from "./control-plane/active-catalog.js";
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
  EDGE_BUILD_MCP_CATALOG,
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

const EDGE_CONNECTOR_RECONNECT_GRACE_MS = 3_000;
const EDGE_CONNECTOR_RECONNECT_POLL_MS = 50;

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
  contractCompatible?: boolean;
  disconnectRecorded?: boolean;
  runtime?: ConnectorRuntimeIdentity;
};

type CompanionAttachment = {
  role: "companion";
  ready: boolean;
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  userId: string;
  deviceId?: string;
  displayName?: string;
  platform?: CompanionPlatform;
  capabilities?: string[];
  workspaces?: CompanionWorkspace[];
};

type PendingRelay = {
  resolve: (response: Response) => void;
  timeout: ReturnType<typeof setTimeout>;
  releaseAbort: () => void;
  unavailableResponse?: (() => Response) | undefined;
  connector: WebSocket;
};

export class McpSession extends DurableObject<EdgeGatewayEnv> {
  private readonly pending = new Map<string, PendingRelay>();
  private readonly connectorTelemetry: ConnectorTelemetryStore;
  private readonly accountStore: EdgeAccountStore;
  private readonly repositoryControlPlane: EdgeRepositoryControlPlane;
  private contractRolloutState!: McpContractRolloutStateV1;
  private activeMcpCatalog: EdgeMcpCatalog | null = null;
  private controlRuntime: EdgeControlPlaneRuntime | undefined;
  private primaryWorkspaceIds: Set<string> | null = null;
  private v3CutoverComplete = false;

  constructor(ctx: DurableObjectState, private readonly edgeEnv: EdgeGatewayEnv) {
    super(ctx, edgeEnv);
    this.connectorTelemetry = new ConnectorTelemetryStore(this.ctx.storage);
    this.accountStore = new EdgeAccountStore(this.ctx.storage);
    this.repositoryControlPlane = new EdgeRepositoryControlPlane(this.accountStore, {
      isDeviceOnline: (deviceId) => this.isCompanionDeviceOnline(deviceId),
      disconnectDevice: (deviceId) => this.disconnectCompanionDevice(deviceId),
    });
    this.ctx.blockConcurrencyWhile(async () => {
      await persistMcpCatalogSnapshot(this.ctx.storage, EDGE_BUILD_MCP_CATALOG);
      const current = await this.ctx.storage.get<unknown>(MCP_CONTRACT_ROLLOUT_STORAGE_KEY);
      const telemetry = await this.connectorTelemetry.read();
      const reconciled = reconcileMcpContractRolloutState(
        current,
        telemetry.catalogContractRevision,
        new Date().toISOString(),
      );
      this.contractRolloutState = reconciled.state;
      if (reconciled.changed) {
        await this.ctx.storage.put(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, reconciled.state);
      }
      this.activeMcpCatalog = await readMcpCatalogSnapshot(
        this.ctx.storage,
        reconciled.state.activeContractRevision,
      );
    });
  }

  async getStatus(): Promise<{
    controlPlaneReady: boolean;
    executionPlaneReady: boolean;
    connectorReady: boolean;
    contractCompatible: boolean;
    activeContractRevision: string;
    candidateContractRevision?: string;
    candidateConnectorReady: boolean;
    candidateRuntime?: ConnectorRuntimeIdentity;
    runtimeTelemetry: EdgeRuntimeTelemetryV1;
  }> {
    const executionConnector = this.getPreferredExecutionReadyConnector();
    const candidateConnector = this.contractRolloutState.candidateContractRevision === undefined
      ? null
      : this.getReadyConnectorForContractRevision(this.contractRolloutState.candidateContractRevision);
    const candidateRuntime = candidateConnector
      ? this.readConnectorAttachment(candidateConnector)?.runtime
      : undefined;
    const connector = executionConnector ?? this.getPreferredReadyConnector();
    const connectorReady = connector !== null;
    const attachment = connector ? this.readConnectorAttachment(connector) : null;
    const contractCompatible = attachment?.protocolVersion === LEGACY_EDGE_PROTOCOL_VERSION ||
      attachment?.contractCompatible === true;
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
    const runtimeTelemetry = await this.connectorTelemetry.read();
    const selectedRuntime = attachment?.runtime;
    return {
      controlPlaneReady,
      executionPlaneReady: controlPlaneReady && executionConnector !== null,
      connectorReady,
      contractCompatible,
      activeContractRevision: this.contractRolloutState.activeContractRevision,
      ...(this.contractRolloutState.candidateContractRevision === undefined
        ? {}
        : { candidateContractRevision: this.contractRolloutState.candidateContractRevision }),
      candidateConnectorReady: candidateConnector !== null,
      ...(candidateRuntime === undefined ? {} : { candidateRuntime }),
      runtimeTelemetry: selectedRuntime === undefined
        ? runtimeTelemetry
        : {
            ...runtimeTelemetry,
            connectorInstanceId: selectedRuntime.connectorInstanceId,
            connectionGeneration: selectedRuntime.connectionGeneration,
            processStartedAt: selectedRuntime.processStartedAt,
            catalogContractRevision: selectedRuntime.catalogContractRevision,
            toolSetRevision: selectedRuntime.toolSetRevision,
            toolCount: selectedRuntime.toolCount,
            serverVersion: selectedRuntime.serverVersion,
            nodePid: selectedRuntime.nodePid,
            hostPid: selectedRuntime.hostPid,
          },
    };
  }

  async getSessionDiagnostics(): Promise<string> {
    return JSON.stringify({ version: 1, events: await readSessionDiagnostics(this.ctx.storage) });
  }

  async getRuntimeTelemetry(): Promise<EdgeRuntimeTelemetryV1> {
    return this.connectorTelemetry.read();
  }

  async promoteContractRollout(input: unknown): Promise<string> {
    const result = await this.promoteContractRolloutResult(input);
    return JSON.stringify(result);
  }

  private async promoteContractRolloutResult(input: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!isRecord(input) || Object.keys(input).sort().join(",") !==
        "expectedActiveContractRevision,expectedCandidateContractRevision" ||
        !isMcpContractRevision(input.expectedActiveContractRevision) ||
        !isMcpContractRevision(input.expectedCandidateContractRevision)) {
      return { status: 400, body: { error: "invalid_contract_promotion" } };
    }

    const candidateConnector = this.getReadyConnectorForContractRevision(
      input.expectedCandidateContractRevision,
    );
    const candidateReadyRevision = candidateConnector
      ? this.readConnectorAttachment(candidateConnector)?.runtime?.catalogContractRevision
      : undefined;
    const promotion = promoteMcpContractRolloutState(
      this.contractRolloutState,
      input.expectedActiveContractRevision,
      input.expectedCandidateContractRevision,
      candidateReadyRevision,
      new Date().toISOString(),
    );
    if (!promotion.ok) {
      return {
        status: 409,
        body: {
          error: promotion.code,
          expectedContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
          activeContractRevision: this.contractRolloutState.activeContractRevision,
          ...(this.contractRolloutState.candidateContractRevision === undefined
            ? {}
            : { candidateContractRevision: this.contractRolloutState.candidateContractRevision }),
        },
      };
    }

    if (!promotion.alreadyPromoted) {
      const promotedCatalog = await readMcpCatalogSnapshot(
        this.ctx.storage,
        promotion.state.activeContractRevision,
      );
      if (!promotedCatalog) {
        return {
          status: 503,
          body: { error: "promoted_catalog_snapshot_unavailable" },
        };
      }
      await this.ctx.storage.put(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, promotion.state);
      this.contractRolloutState = promotion.state;
      this.activeMcpCatalog = promotedCatalog;
      this.controlRuntime = undefined;
    }
    this.refreshOpenConnectorContractCompatibility();
    return {
      status: 200,
      body: {
        status: promotion.alreadyPromoted ? "already-promoted" : "promoted",
        activeContractRevision: this.contractRolloutState.activeContractRevision,
      },
    };
  }

  async rollbackContractRollout(input: unknown): Promise<string> {
    const result = await this.rollbackContractRolloutResult(input);
    return JSON.stringify(result);
  }

  private async rollbackContractRolloutResult(input: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!isRecord(input) || Object.keys(input).sort().join(",") !==
        "expectedActiveContractRevision,expectedPreviousContractRevision" ||
        !isMcpContractRevision(input.expectedActiveContractRevision) ||
        !isMcpContractRevision(input.expectedPreviousContractRevision)) {
      return { status: 400, body: { error: "invalid_contract_rollback" } };
    }

    const previousConnector = this.getReadyConnectorForContractRevision(
      input.expectedPreviousContractRevision,
    );
    const previousReadyRevision = previousConnector
      ? this.readConnectorAttachment(previousConnector)?.runtime?.catalogContractRevision
      : undefined;
    const rollback = rollbackMcpContractRolloutState(
      this.contractRolloutState,
      input.expectedActiveContractRevision,
      input.expectedPreviousContractRevision,
      previousReadyRevision,
      new Date().toISOString(),
    );
    if (!rollback.ok) {
      return {
        status: 409,
        body: {
          error: rollback.code,
          activeContractRevision: this.contractRolloutState.activeContractRevision,
          ...(this.contractRolloutState.previousContractRevision === undefined
            ? {}
            : { previousContractRevision: this.contractRolloutState.previousContractRevision }),
        },
      };
    }

    if (!rollback.alreadyRolledBack) {
      const restoredCatalog = await readMcpCatalogSnapshot(
        this.ctx.storage,
        rollback.state.activeContractRevision,
      );
      if (!restoredCatalog) {
        return {
          status: 503,
          body: { error: "rollback_catalog_snapshot_unavailable" },
        };
      }
      await this.ctx.storage.put(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, rollback.state);
      this.contractRolloutState = rollback.state;
      this.activeMcpCatalog = restoredCatalog;
      this.controlRuntime = undefined;
    }
    this.refreshOpenConnectorContractCompatibility();
    return {
      status: 200,
      body: {
        status: rollback.alreadyRolledBack ? "already-rolled-back" : "rolled-back",
        activeContractRevision: this.contractRolloutState.activeContractRevision,
        ...(this.contractRolloutState.candidateContractRevision === undefined
          ? {}
          : { candidateContractRevision: this.contractRolloutState.candidateContractRevision }),
      },
    };
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
    if (url.pathname === "/companion") {
      return this.handleCompanionUpgrade(request);
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

    const companionAttachment = this.readCompanionAttachment(webSocket);
    if (companionAttachment) {
      this.ctx.waitUntil(this.handleCompanionMessage(webSocket, message, companionAttachment));
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
      this.primaryWorkspaceIds = null;
      const runtime = "runtime" in parsed ? parsed.runtime : undefined;
      const contractCompatible = attachment.protocolVersion === LEGACY_EDGE_PROTOCOL_VERSION ||
        isConnectorContractCompatible(runtime, this.contractRolloutState);
      webSocket.serializeAttachment({
        role: "connector",
        ready: true,
        protocolVersion: attachment.protocolVersion,
        disconnectRecorded: false,
        contractCompatible,
        ...(runtime === undefined ? {} : { connectionGeneration: runtime.connectionGeneration }),
        ...(runtime === undefined ? {} : { runtime }),
      } satisfies ConnectorAttachment);
      const selected = this.getPreferredExecutionReadyConnector();
      if (selected === webSocket) {
        this.updateConnectorTelemetry({
          type: "ready",
          at: new Date().toISOString(),
          ...(runtime === undefined ? {} : { runtime }),
        });
      }
      if (attachment.protocolVersion === EDGE_PROTOCOL_VERSION) {
        this.v3CutoverComplete = true;
        this.ctx.waitUntil(this.ctx.storage.put("edge:v3-cutover-complete", true));
      }
      return;
    }

    const pending = this.pending.get(parsed.requestId);
    if (!pending || pending.connector !== webSocket) return;

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

  override webSocketClose(webSocket: WebSocket, code: number, _reason: string, wasClean: boolean): void {
    this.recordConnectorDisconnect(webSocket, { source: "close", closeCode: code, wasClean });
    this.failPendingRequestsForConnector(webSocket, "connector_disconnected");
  }

  override webSocketError(webSocket: WebSocket, _error: unknown): void {
    this.recordConnectorDisconnect(webSocket, { source: "error" });
    this.failPendingRequestsForConnector(webSocket, "connector_error");
  }
  private async handleAllowedRequest(request: Request): Promise<Response> {
    const preferredConnector = this.getPreferredExecutionReadyConnector();
    const preferredAttachment = preferredConnector
      ? this.readConnectorAttachment(preferredConnector)
      : null;
    if (preferredConnector && preferredAttachment?.protocolVersion === LEGACY_EDGE_PROTOCOL_VERSION) {
      return this.relayLegacyRequest(request, preferredConnector);
    }

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
      await this.recordSessionDiagnostic(
        diagnosticRequest,
        localResponse.clone(),
        getMcpResponseDiagnostic(localResponse),
      );
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
    responseMetadata?: Parameters<typeof classifySessionDiagnostic>[3],
  ): Promise<void> {
    try {
      const event = await classifySessionDiagnostic(request, response, undefined, responseMetadata);
      if (!shouldPersistSessionDiagnostic(event)) return;
      await appendSessionDiagnostic(this.ctx.storage, event);
      console.log(JSON.stringify({ event: "mcp_session_diagnostic", ...event }));
    } catch {
      console.warn(JSON.stringify({ event: "mcp_session_diagnostic_failed" }));
    }
  }
  private getControlRuntime(): EdgeControlPlaneRuntime {
    if (!this.activeMcpCatalog) {
      throw new EdgeControlPlaneConfigurationError("Active MCP catalog snapshot is unavailable.");
    }
    this.controlRuntime ??= createEdgeControlPlaneRuntime(
      this.edgeEnv,
      this.ctx.storage,
      {
        isReady: () => this.getExecutionReadyConnector(EDGE_PROTOCOL_VERSION) !== null,
        getGeneration: () => this.getExecutionReadyConnectorGeneration(),
        waitUntilReady: () => this.waitForExecutionReconnect(),
        execute: async (body, principal, request) => {
          if (!request) return createAgentUnavailableMcpResponse(body);
          return this.relayRoutedMcpRequest(
            request,
            body,
            principal,
            () => createAgentUnavailableMcpResponse(body),
          );
        },
      },
      this.activeMcpCatalog,
      {
        handle: async (body, principal, request) => {
          const cloudResponse = await this.repositoryControlPlane.handle(body, principal);
          if (cloudResponse || !request) return cloudResponse;
          return this.tryRelayCompanionMcpRequest(request, body, principal);
        },
      },
    );
    return this.controlRuntime;
  }

  private isCompanionDeviceOnline(deviceId: string): boolean {
    for (const webSocket of this.ctx.getWebSockets("companion")) {
      if (webSocket.readyState !== WebSocket.OPEN) continue;
      const attachment = webSocket.deserializeAttachment();
      if (typeof attachment === "object" && attachment !== null && "role" in attachment && attachment.role === "companion" && "deviceId" in attachment && attachment.deviceId === deviceId) return true;
    }
    return false;
  }

  private disconnectCompanionDevice(deviceId: string): void {
    for (const webSocket of this.ctx.getWebSockets("companion")) {
      const attachment = webSocket.deserializeAttachment();
      if (typeof attachment === "object" && attachment !== null && "role" in attachment && attachment.role === "companion" && "deviceId" in attachment && attachment.deviceId === deviceId) {
        try { webSocket.close(1008, "device revoked"); } catch { /* already closed */ }
      }
    }
  }

  private getReadyCompanionsForUser(
    userId: string,
    deviceId?: string,
  ): Array<{ webSocket: WebSocket; attachment: CompanionAttachment }> {
    const companions: Array<{ webSocket: WebSocket; attachment: CompanionAttachment }> = [];
    for (const webSocket of this.ctx.getWebSockets("companion")) {
      const attachment = this.readCompanionAttachment(webSocket);
      if (!attachment || !isCompanionEligibleForUser({
        online: webSocket.readyState === WebSocket.OPEN,
        ready: attachment.ready,
        userId: attachment.userId,
        ...(attachment.deviceId === undefined ? {} : { deviceId: attachment.deviceId }),
      }, userId, deviceId)) continue;
      companions.push({ webSocket, attachment });
    }
    return companions;
  }

  private getCompanionRouteCandidates(userId: string) {
    return this.getReadyCompanionsForUser(userId).map(({ webSocket, attachment }) => ({
      target: { webSocket, attachment },
      deviceId: attachment.deviceId!,
      workspaceIds: (attachment.workspaces ?? []).map((workspace) => workspace.workspaceId),
    }));
  }

  private async relayRoutedMcpRequest(
    request: Request,
    body: unknown,
    principal: AuthenticatedEdgePrincipal,
    unavailableResponse?: () => Response,
  ): Promise<Response> {
    const companionResponse = await this.tryRelayCompanionMcpRequest(
      request,
      body,
      principal,
      unavailableResponse,
    );
    if (companionResponse) return companionResponse;
    return this.relayAuthenticatedRequest(request, JSON.stringify(body), principal, unavailableResponse);
  }

  private async tryRelayCompanionMcpRequest(
    request: Request,
    body: unknown,
    principal: AuthenticatedEdgePrincipal,
    unavailableResponse?: () => Response,
  ): Promise<Response | null> {
    const invocation = readMcpToolInvocation(body);
    if (!invocation) return null;

    if (COMPANION_LOCAL_REPOSITORY_TOOLS.has(invocation.name) && !principal.userId) {
      return mcpToolError(body, "IDENTITY_REQUIRED", "Individual MCP V3 identity is required for local repository operations.");
    }

    if (invocation.name === "list_workspaces" && principal.userId) {
      const companions = this.getReadyCompanionsForUser(principal.userId);
      if (companions.length === 0) return null;
      return this.relayAggregatedWorkspaceList(request, body, principal, unavailableResponse);
    }

    if (!principal.userId) return null;

    if (invocation.name.startsWith("browser_")) {
      return this.tryRelayBrowserTool(
        request,
        body,
        { ...principal, userId: principal.userId },
        invocation,
        unavailableResponse,
      );
    }

    if (invocation.name === "import_repositories") {
      return this.importRepositoriesOnCompanion(
        request,
        body,
        { ...principal, userId: principal.userId },
        invocation,
      );
    }

    if (invocation.name === "materialize_repository") {
      return this.materializeRepositoryOnCompanion(
        request,
        body,
        { ...principal, userId: principal.userId },
        invocation,
      );
    }

    if (COMPANION_LOCAL_REPOSITORY_TOOLS.has(invocation.name)) {
      if (invocation.name === "sync_repository") {
        const repositoryId = typeof invocation.arguments.repositoryId === "string"
          ? invocation.arguments.repositoryId
          : "";
        if (!repositoryId || !(await this.accountStore.getRepositoryForUser(principal.userId, repositoryId))) {
          return mcpToolError(body, "REPOSITORY_NOT_FOUND", "Repository is not available to this user.");
        }
      }

      const requestedDeviceId = typeof invocation.arguments.deviceId === "string"
        ? invocation.arguments.deviceId
        : undefined;
      const selection = selectCompanionDevice(
        this.getCompanionRouteCandidates(principal.userId),
        requestedDeviceId,
      );
      if (selection.kind === "none") {
        return mcpToolError(body, "AGENT_UNAVAILABLE", "No authorized MCP V3 local runtime is online for this repository operation.");
      }
      if (selection.kind === "ambiguous") {
        return mcpToolError(body, "DEVICE_SELECTION_REQUIRED", "More than one MCP V3 device is online; choose a deviceId.");
      }
      return this.relayAuthenticatedRequestTo(
        request,
        JSON.stringify(body),
        principal,
        selection.candidate.target.webSocket,
        COMPANION_PROTOCOL_VERSION,
        unavailableResponse,
      );
    }

    const workspaceId = typeof invocation.arguments.workspaceId === "string"
      ? invocation.arguments.workspaceId
      : undefined;
    if (!workspaceId) return null;

    const routeCandidates = this.getCompanionRouteCandidates(principal.userId);
    if (!routeCandidates.some((candidate) => candidate.workspaceIds.includes(workspaceId))) {
      return null;
    }

    const primaryIds = await this.ensurePrimaryWorkspaceIds(request, principal);
    if (primaryIds === null) {
      return mcpToolError(body, "WORKSPACE_ROUTE_UNRESOLVED", "Primary workspace ownership could not be verified.");
    }
    const route = selectWorkspaceRuntime(routeCandidates, workspaceId, primaryIds);
    if (route.kind === "collision") {
      return mcpToolError(body, "WORKSPACE_ID_COLLISION", "workspaceId is announced by more than one execution runtime.");
    }
    if (route.kind !== "companion") return null;

    return this.relayAuthenticatedRequestTo(
      request,
      JSON.stringify(body),
      principal,
      route.candidate.target.webSocket,
      COMPANION_PROTOCOL_VERSION,
      unavailableResponse,
    );
  }

  private async tryRelayBrowserTool(
    request: Request,
    body: unknown,
    principal: AuthenticatedEdgePrincipal & { userId: string },
    invocation: { id: string | number | null; name: string; arguments: Record<string, unknown> },
    unavailableResponse?: () => Response,
  ): Promise<Response | null> {
    const browserCompanions = this.getReadyCompanionsForUser(principal.userId)
      .filter(({ attachment }) => attachment.capabilities?.includes("browser"))
      .map(({ webSocket, attachment }) => ({
        target: { webSocket, attachment },
        deviceId: attachment.deviceId!,
        workspaceIds: (attachment.workspaces ?? []).map((workspace) => workspace.workspaceId),
      }));
    if (browserCompanions.length === 0) return null;

    const requestedDeviceId = typeof invocation.arguments.deviceId === "string"
      ? invocation.arguments.deviceId
      : undefined;
    const tabId = typeof invocation.arguments.tabId === "string"
      ? invocation.arguments.tabId
      : undefined;
    const taskId = typeof invocation.arguments.taskId === "string"
      ? invocation.arguments.taskId
      : undefined;

    const affinityDeviceIds = new Set<string>();
    for (const [kind, id] of [["tab", tabId], ["task", taskId]] as const) {
      if (!id) continue;
      const deviceId = await this.ctx.storage.get<string>(
        browserAffinityKey(principal.userId, kind, id),
      );
      if (deviceId) affinityDeviceIds.add(deviceId);
    }
    if (affinityDeviceIds.size > 1) {
      return mcpToolError(
        body,
        "BROWSER_ROUTE_CONFLICT",
        "Browser tab/task affinity points to different MCP V3 devices.",
      );
    }
    const affinityDeviceId = [...affinityDeviceIds][0];
    if (requestedDeviceId && affinityDeviceId &&
        requestedDeviceId !== affinityDeviceId) {
      return mcpToolError(
        body,
        "BROWSER_ROUTE_CONFLICT",
        "Requested device conflicts with the existing browser tab/task affinity.",
      );
    }
    const targetDeviceId = requestedDeviceId ?? affinityDeviceId;
    const selection = selectCompanionDevice(
      browserCompanions,
      targetDeviceId,
    );
    if (selection.kind === "none") {
      return targetDeviceId
        ? mcpToolError(
            body,
            "AGENT_UNAVAILABLE",
            "The MCP V3 device owning this browser context is not online.",
          )
        : null;
    }
    if (selection.kind === "ambiguous") {
      return mcpToolError(
        body,
        "DEVICE_SELECTION_REQUIRED",
        "More than one browser-capable MCP V3 device is online; choose deviceId.",
      );
    }

    const selectedDeviceId = selection.candidate.deviceId;
    const response = await this.relayAuthenticatedRequestTo(
      request,
      JSON.stringify(body),
      principal,
      selection.candidate.target.webSocket,
      COMPANION_PROTOCOL_VERSION,
      unavailableResponse,
    );

    const structured = await readMcpStructuredContent(response.clone());
    if (structured) {
      const affinities = collectBrowserAffinityIds(structured);
      const writes: Record<string, string> = {};
      for (const id of affinities.tabIds) {
        writes[browserAffinityKey(principal.userId, "tab", id)] =
          selectedDeviceId;
      }
      for (const id of affinities.taskIds) {
        writes[browserAffinityKey(principal.userId, "task", id)] =
          selectedDeviceId;
      }
      if (Object.keys(writes).length > 0) {
        await this.ctx.storage.put(writes);
      }

      if (invocation.name === "browser_close_tab" && tabId) {
        await this.ctx.storage.delete(
          browserAffinityKey(principal.userId, "tab", tabId),
        );
      }
      if (invocation.name === "browser_finish_task" && taskId) {
        await this.ctx.storage.delete(
          browserAffinityKey(principal.userId, "task", taskId),
        );
      }
    }
    return response;
  }

  private async importRepositoriesOnCompanion(
    request: Request,
    body: unknown,
    principal: AuthenticatedEdgePrincipal & { userId: string },
    invocation: { id: string | number | null; name: string; arguments: Record<string, unknown> },
  ): Promise<Response> {
    const root = typeof invocation.arguments.root === "string"
      ? invocation.arguments.root
      : "";
    const paths = Array.isArray(invocation.arguments.paths) &&
      invocation.arguments.paths.every((value) => typeof value === "string")
      ? invocation.arguments.paths as string[]
      : null;
    const mode = invocation.arguments.mode === undefined
      ? "preserve-path"
      : invocation.arguments.mode;
    const requestedDeviceId = typeof invocation.arguments.deviceId === "string"
      ? invocation.arguments.deviceId
      : undefined;

    if (!root || !paths || paths.length === 0) {
      return mcpToolError(body, "INVALID_ARGUMENT", "root and at least one repository path are required.");
    }
    const selection = selectCompanionDevice(
      this.getCompanionRouteCandidates(principal.userId),
      requestedDeviceId,
    );
    if (selection.kind === "none") {
      return mcpToolError(body, "AGENT_UNAVAILABLE", "No authorized MCP V3 local runtime is online for repository import.");
    }
    if (selection.kind === "ambiguous") {
      return mcpToolError(body, "DEVICE_SELECTION_REQUIRED", "More than one MCP V3 device is online; choose a deviceId.");
    }

    const selected = selection.candidate.target;
    const deviceId = selection.candidate.deviceId;
    const discoveryRequest = {
      jsonrpc: "2.0",
      id: `edge-import-discovery-${crypto.randomUUID()}`,
      method: "tools/call",
      params: {
        name: "discover_local_repositories",
        arguments: { root, maxDepth: 8 },
      },
    };

    const createdRepositoryIds: string[] = [];
    const bindings: InternalRepositoryBinding[] = [];
    const repositoryIds: string[] = [];
    const previousMaterializations = new Map<string, StoredMaterialization | null>();
    let cloudMaterializationsCommitted = false;
    try {
      const discoveryResponse = await this.relayAuthenticatedRequestTo(
        request,
        JSON.stringify(discoveryRequest),
        principal,
        selected.webSocket,
        COMPANION_PROTOCOL_VERSION,
      );
      const discovered = await readDiscoveredRepositoriesResponse(discoveryResponse);
      if (!discovered) {
        throw new Error("Local repository discovery failed.");
      }

      const requestedKeys = paths.map((value) =>
        companionPathKey(value, selected.attachment.platform),
      );
      if (new Set(requestedKeys).size !== requestedKeys.length) {
        return mcpToolError(body, "INVALID_ARGUMENT", "Repository paths must be unique.");
      }

      const discoveredByPath = new Map(
        discovered.map((repository) => [
          companionPathKey(repository.path, selected.attachment.platform),
          repository,
        ]),
      );
      const selectedRepositories: DiscoveredRepositoryEntry[] = [];
      for (const key of requestedKeys) {
        const repository = discoveredByPath.get(key);
        if (!repository) {
          return mcpToolError(
            body,
            "REPOSITORY_NOT_FOUND",
            "One or more selected paths were not discovered as Git repositories under the supplied root.",
          );
        }
        selectedRepositories.push(repository);
      }

      const cloudRepositories = await this.accountStore.listRepositories(principal.userId);
      const usedNames = new Set(
        cloudRepositories.map(({ repository }) => normalizedRepositoryDisplayName(repository.name)),
      );
      for (const discoveredRepository of selectedRepositories) {
        const existingPath = await this.accountStore.findMaterializationByDevicePath(
          principal.userId,
          deviceId,
          discoveredRepository.path,
        );
        if (existingPath) {
          repositoryIds.push(existingPath.repository.id);
          bindings.push({
            repositoryId: existingPath.repository.id,
            name: existingPath.repository.name,
            path: discoveredRepository.path,
            workspaceId: existingPath.materialization.workspaceId,
            remoteUrls: discoveredRepository.remoteUrls,
            managed: false,
          });
          continue;
        }

        const remoteMatches = discoveredRepository.remoteUrls.length === 0
          ? []
          : cloudRepositories.filter(({ repository }) =>
              (repository.remoteUrls ?? []).some((remote) =>
                discoveredRepository.remoteUrls.includes(remote),
              ),
            );
        if (remoteMatches.length > 1) {
          throw new Error("More than one cloud repository matches the discovered Git remote.");
        }

        let repository = remoteMatches[0]?.repository;
        if (!repository) {
          const name = nextAvailableRepositoryName(discoveredRepository.name, usedNames);
          repository = await this.accountStore.createRepository(
            principal.userId,
            name,
            discoveredRepository.remoteUrls,
          );
          createdRepositoryIds.push(repository.id);
          cloudRepositories.push({ repository, role: "owner" });
          usedNames.add(normalizedRepositoryDisplayName(repository.name));
        }

        repositoryIds.push(repository.id);
        bindings.push({
          repositoryId: repository.id,
          name: repository.name,
          path: discoveredRepository.path,
          workspaceId: discoveredRepository.workspaceId,
          remoteUrls: discoveredRepository.remoteUrls,
          managed: false,
        });
      }

      const prepareRequest = {
        jsonrpc: "2.0",
        id: `edge-import-prepare-${crypto.randomUUID()}`,
        method: "tools/call",
        params: {
          name: COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL,
          arguments: { bindings, dryRun: true, mode },
        },
      };
      const prepareResponse = await this.relayAuthenticatedRequestTo(
        request,
        JSON.stringify(prepareRequest),
        principal,
        selected.webSocket,
        COMPANION_PROTOCOL_VERSION,
      );
      const prepared = await readInternalBindingsResponse(prepareResponse);
      if (!prepared || prepared.length !== bindings.length) {
        throw new Error("Local repository binding validation failed.");
      }

      const canonicalBindings = bindings.map((binding, index) => {
        const validated = prepared[index];
        if (!validated ||
            validated.repositoryId !== binding.repositoryId ||
            companionPathKey(validated.path, selected.attachment.platform) !==
              companionPathKey(binding.path, selected.attachment.platform)) {
          throw new Error("Local repository binding validation did not match the requested repositories.");
        }
        return {
          ...binding,
          path: validated.path,
          workspaceId: validated.workspaceId,
        };
      });
      bindings.splice(0, bindings.length, ...canonicalBindings);

      for (const binding of canonicalBindings) {
        const current = (await this.accountStore.listMaterializations(
          principal.userId,
          binding.repositoryId,
        )).find((value) =>
          value.deviceId === deviceId &&
          value.workspaceId === binding.workspaceId
        ) ?? null;
        previousMaterializations.set(
          materializationRollbackKey(binding.repositoryId, binding.workspaceId),
          current,
        );
      }

      await this.ctx.storage.transaction(async (transaction) => {
        const transactionalStore = new EdgeAccountStore(transaction);
        for (const binding of canonicalBindings) {
          await transactionalStore.upsertMaterialization(principal.userId, deviceId, {
            repositoryId: binding.repositoryId,
            workspaceId: binding.workspaceId,
            path: binding.path,
            platform: selected.attachment.platform ?? "unknown",
          });
        }
      });
      cloudMaterializationsCommitted = true;

      const repositories = [];
      for (const repositoryId of repositoryIds) {
        const details = await this.repositoryControlPlane.readRepositoryDetails(
          principal.userId,
          repositoryId,
        );
        if (!details) throw new Error("Imported repository details became unavailable.");
        repositories.push(details);
      }

      const bindRequest = {
        jsonrpc: "2.0",
        id: `edge-import-bind-${crypto.randomUUID()}`,
        method: "tools/call",
        params: {
          name: COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL,
          arguments: { bindings, dryRun: false, mode },
        },
      };
      const bindResponse = await this.relayAuthenticatedRequestTo(
        request,
        JSON.stringify(bindRequest),
        principal,
        selected.webSocket,
        COMPANION_PROTOCOL_VERSION,
      );
      const bound = await readInternalBindingsResponse(bindResponse);
      if (!bound || bound.length !== canonicalBindings.length) {
        throw new Error("Local repository binding failed.");
      }
      for (let index = 0; index < canonicalBindings.length; index += 1) {
        const expected = canonicalBindings[index]!;
        const actual = bound[index]!;
        if (actual.repositoryId !== expected.repositoryId ||
            actual.workspaceId !== expected.workspaceId ||
            companionPathKey(actual.path, selected.attachment.platform) !==
              companionPathKey(expected.path, selected.attachment.platform)) {
          throw new Error("Local repository binding response changed after validation.");
        }
      }

      return mcpToolSuccess(body, { repositories });
    } catch (error) {
      const rollbackFailures: string[] = [];
      if (cloudMaterializationsCommitted) {
        try {
          await this.ctx.storage.transaction(async (transaction) => {
            const transactionalStore = new EdgeAccountStore(transaction);
            for (const binding of bindings) {
              const key = materializationRollbackKey(
                binding.repositoryId,
                binding.workspaceId,
              );
              const previous = previousMaterializations.get(key) ?? null;
              if (previous) {
                await transactionalStore.upsertMaterialization(
                  principal.userId,
                  deviceId,
                  {
                    id: previous.id,
                    repositoryId: previous.repositoryId,
                    workspaceId: previous.workspaceId,
                    path: previous.path,
                    platform: previous.platform,
                  },
                );
                continue;
              }
              const current = (await transactionalStore.listMaterializations(
                principal.userId,
                binding.repositoryId,
              )).find((value) =>
                value.deviceId === deviceId &&
                value.workspaceId === binding.workspaceId
              );
              if (current) {
                const removed = await transactionalStore.deleteMaterialization(
                  principal.userId,
                  binding.repositoryId,
                  current.id,
                );
                if (!removed) {
                  throw new Error(
                    `Materialization rollback failed for ${binding.repositoryId}/${binding.workspaceId}.`,
                  );
                }
              }
            }
          });
        } catch (rollbackError) {
          rollbackFailures.push(
            rollbackError instanceof Error
              ? rollbackError.message
              : "Cloud materialization rollback failed.",
          );
        }
      }
      for (const repositoryId of createdRepositoryIds.reverse()) {
        try {
          const removed = await this.accountStore.deleteOwnedRepositoryIfUnmaterialized(
            principal.userId,
            repositoryId,
          );
          if (!removed) {
            rollbackFailures.push(
              `New repository cleanup failed for ${repositoryId}.`,
            );
          }
        } catch (cleanupError) {
          rollbackFailures.push(
            cleanupError instanceof Error
              ? cleanupError.message
              : `New repository cleanup failed for ${repositoryId}.`,
          );
        }
      }
      const originalMessage = error instanceof Error
        ? error.message
        : "Repository import failed.";
      if (rollbackFailures.length > 0) {
        return mcpToolError(
          body,
          "REPOSITORY_IMPORT_ROLLBACK_FAILED",
          `${originalMessage} Rollback failure: ${rollbackFailures.join(" | ")}`,
        );
      }
      return mcpToolError(
        body,
        "REPOSITORY_IMPORT_FAILED",
        originalMessage,
      );
    }
  }

  private async materializeRepositoryOnCompanion(
    request: Request,
    body: unknown,
    principal: AuthenticatedEdgePrincipal & { userId: string },
    invocation: { id: string | number | null; name: string; arguments: Record<string, unknown> },
  ): Promise<Response> {
    const repositoryId = typeof invocation.arguments.repositoryId === "string"
      ? invocation.arguments.repositoryId
      : "";
    const targetName = typeof invocation.arguments.targetName === "string"
      ? invocation.arguments.targetName.trim()
      : undefined;
    const requestedDeviceId = typeof invocation.arguments.deviceId === "string"
      ? invocation.arguments.deviceId
      : undefined;
    if (!repositoryId) {
      return mcpToolError(body, "INVALID_ARGUMENT", "repositoryId is required.");
    }

    const access = await this.accountStore.getRepositoryForUser(
      principal.userId,
      repositoryId,
    );
    if (!access) {
      return mcpToolError(
        body,
        "REPOSITORY_NOT_FOUND",
        "Repository is not available to this user.",
      );
    }
    const remoteUrls = access.repository.remoteUrls ?? [];
    if (remoteUrls.length === 0) {
      return mcpToolError(
        body,
        "REPOSITORY_REMOTE_REQUIRED",
        "Repository has no remote source that can be materialized on another device.",
      );
    }

    const selection = selectCompanionDevice(
      this.getCompanionRouteCandidates(principal.userId),
      requestedDeviceId,
    );
    if (selection.kind === "none") {
      return mcpToolError(
        body,
        "AGENT_UNAVAILABLE",
        "No authorized MCP V3 local runtime is online for repository materialization.",
      );
    }
    if (selection.kind === "ambiguous") {
      return mcpToolError(
        body,
        "DEVICE_SELECTION_REQUIRED",
        "More than one MCP V3 device is online; choose a deviceId.",
      );
    }

    const selected = selection.candidate.target;
    const deviceId = selection.candidate.deviceId;
    const existingForDevice = (await this.accountStore.listMaterializations(
      principal.userId,
      repositoryId,
    )).filter((value) => value.deviceId === deviceId);
    if (existingForDevice.length > 1) {
      return mcpToolError(
        body,
        "MATERIALIZATION_AMBIGUOUS",
        "Repository has more than one materialization on the selected device.",
      );
    }
    const previous = existingForDevice[0] ?? null;

    const internalArguments = {
      repositoryId,
      name: access.repository.name,
      remoteUrls: [...remoteUrls],
      ...(targetName ? { targetName } : {}),
      ...(previous ? { workspaceId: previous.workspaceId } : {}),
    };
    const prepareRequest = {
      jsonrpc: "2.0",
      id: `edge-materialize-prepare-${crypto.randomUUID()}`,
      method: "tools/call",
      params: {
        name: COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL,
        arguments: { ...internalArguments, dryRun: true },
      },
    };

    const prepareResponse = await this.relayAuthenticatedRequestTo(
      request,
      JSON.stringify(prepareRequest),
      principal,
      selected.webSocket,
      COMPANION_PROTOCOL_VERSION,
    );
    const planned = await readInternalMaterializationResponse(prepareResponse);
    if (!planned || planned.repositoryId !== repositoryId) {
      return mcpToolError(
        body,
        "REPOSITORY_MATERIALIZATION_FAILED",
        "Local repository materialization validation failed.",
      );
    }

    const previousForPlannedWorkspace = (await this.accountStore.listMaterializations(
      principal.userId,
      repositoryId,
    )).find((value) =>
      value.deviceId === deviceId &&
      value.workspaceId === planned.workspaceId
    ) ?? null;
    let cloudCommitted = false;
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        const transactionalStore = new EdgeAccountStore(transaction);
        await transactionalStore.upsertMaterialization(
          principal.userId,
          deviceId,
          {
            repositoryId,
            workspaceId: planned.workspaceId,
            path: planned.path,
            platform: selected.attachment.platform ?? "unknown",
          },
        );
      });
      cloudCommitted = true;

      const materializeRequest = {
        jsonrpc: "2.0",
        id: `edge-materialize-commit-${crypto.randomUUID()}`,
        method: "tools/call",
        params: {
          name: COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL,
          arguments: {
            ...internalArguments,
            workspaceId: planned.workspaceId,
            dryRun: false,
          },
        },
      };
      const materializeResponse = await this.relayAuthenticatedRequestTo(
        request,
        JSON.stringify(materializeRequest),
        principal,
        selected.webSocket,
        COMPANION_PROTOCOL_VERSION,
      );
      const actual = await readInternalMaterializationResponse(
        materializeResponse,
      );
      if (!actual ||
          actual.repositoryId !== planned.repositoryId ||
          actual.workspaceId !== planned.workspaceId ||
          companionPathKey(actual.path, selected.attachment.platform) !==
            companionPathKey(planned.path, selected.attachment.platform)) {
        throw new Error(
          "Local repository materialization changed after validation.",
        );
      }

      const details = await this.repositoryControlPlane.readRepositoryDetails(
        principal.userId,
        repositoryId,
      );
      if (!details) {
        throw new Error("Materialized repository details became unavailable.");
      }
      const materialization = details.materializations.find((value) =>
        value.deviceId === deviceId &&
        value.workspaceId === planned.workspaceId
      );
      if (!materialization) {
        throw new Error("Materialized repository state is unavailable.");
      }
      return mcpToolSuccess(body, {
        repository: details,
        materialization,
      });
    } catch (error) {
      let rollbackFailure: string | null = null;
      if (cloudCommitted) {
        try {
          await this.ctx.storage.transaction(async (transaction) => {
            const transactionalStore = new EdgeAccountStore(transaction);
            if (previousForPlannedWorkspace) {
              await transactionalStore.upsertMaterialization(
                principal.userId,
                deviceId,
                {
                  id: previousForPlannedWorkspace.id,
                  repositoryId: previousForPlannedWorkspace.repositoryId,
                  workspaceId: previousForPlannedWorkspace.workspaceId,
                  path: previousForPlannedWorkspace.path,
                  platform: previousForPlannedWorkspace.platform,
                },
              );
              return;
            }
            const current = (await transactionalStore.listMaterializations(
              principal.userId,
              repositoryId,
            )).find((value) =>
              value.deviceId === deviceId &&
              value.workspaceId === planned.workspaceId
            );
            if (current) {
              const removed = await transactionalStore.deleteMaterialization(
                principal.userId,
                repositoryId,
                current.id,
              );
              if (!removed) {
                throw new Error("Cloud materialization rollback failed.");
              }
            }
          });
        } catch (rollbackError) {
          rollbackFailure = rollbackError instanceof Error
            ? rollbackError.message
            : "Cloud materialization rollback failed.";
        }
      }

      const message = error instanceof Error
        ? error.message
        : "Repository materialization failed.";
      if (rollbackFailure) {
        return mcpToolError(
          body,
          "REPOSITORY_MATERIALIZATION_ROLLBACK_FAILED",
          `${message} Rollback failure: ${rollbackFailure}`,
        );
      }
      return mcpToolError(
        body,
        "REPOSITORY_MATERIALIZATION_FAILED",
        message,
      );
    }
  }

  private async relayAggregatedWorkspaceList(
    request: Request,
    body: unknown,
    principal: AuthenticatedEdgePrincipal,
    unavailableResponse?: () => Response,
  ): Promise<Response> {
    const primaryConnector = this.getExecutionReadyConnector(EDGE_PROTOCOL_VERSION);
    let primaryWorkspaces: WorkspaceListEntry[] = [];
    if (primaryConnector) {
      const primaryResponse = await this.relayAuthenticatedRequestTo(
        request,
        JSON.stringify(body),
        principal,
        primaryConnector,
        EDGE_PROTOCOL_VERSION,
        unavailableResponse,
      );
      const parsed = await readWorkspaceListResponse(primaryResponse.clone());
      if (parsed === null) return primaryResponse;
      primaryWorkspaces = parsed;
    }

    const merged = new Map<string, WorkspaceListEntry>();
    for (const workspace of primaryWorkspaces) merged.set(workspace.id, workspace);
    this.primaryWorkspaceIds = new Set(primaryWorkspaces.map((workspace) => workspace.id));

    for (const { attachment } of this.getReadyCompanionsForUser(principal.userId!)) {
      for (const workspace of attachment.workspaces ?? []) {
        if (merged.has(workspace.workspaceId)) {
          return mcpToolError(body, "WORKSPACE_ID_COLLISION", `workspaceId '${workspace.workspaceId}' is announced by more than one runtime.`);
        }
        merged.set(workspace.workspaceId, {
          id: workspace.workspaceId,
          name: workspace.name,
          workspaceKind: workspace.workspaceKind,
          enabled: true,
          permissionProfile: workspace.permissionProfile,
          confirmationMode: workspace.confirmationMode,
          writesEnabled: workspace.writesEnabled,
          shellsEnabled: workspace.shellsEnabled,
          allowedShells: [...workspace.allowedShells],
        });
      }
    }

    return mcpToolSuccess(body, {
      workspaces: [...merged.values()].sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  private async ensurePrimaryWorkspaceIds(
    request: Request,
    principal: AuthenticatedEdgePrincipal,
  ): Promise<Set<string> | null> {
    if (this.primaryWorkspaceIds) return this.primaryWorkspaceIds;
    const connector = this.getExecutionReadyConnector(EDGE_PROTOCOL_VERSION);
    if (!connector) {
      this.primaryWorkspaceIds = new Set<string>();
      return this.primaryWorkspaceIds;
    }
    const probe = {
      jsonrpc: "2.0",
      id: `edge-workspace-probe-${crypto.randomUUID()}`,
      method: "tools/call",
      params: { name: "list_workspaces", arguments: {} },
    };
    const response = await this.relayAuthenticatedRequestTo(
      request,
      JSON.stringify(probe),
      principal,
      connector,
      EDGE_PROTOCOL_VERSION,
    );
    const workspaces = await readWorkspaceListResponse(response);
    if (workspaces === null) return null;
    this.primaryWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    return this.primaryWorkspaceIds;
  }

  private async waitForExecutionReconnect(): Promise<boolean> {
    if (this.getExecutionReadyConnector(EDGE_PROTOCOL_VERSION) !== null) return true;

    const telemetry = await this.connectorTelemetry.read();
    if (
      telemetry.reconnectGraceStartedAt === undefined ||
      telemetry.reconnectGraceGeneration === undefined ||
      telemetry.reconnectGraceGeneration !== telemetry.connectionGeneration
    ) {
      return false;
    }

    const disconnectedAt = Date.parse(telemetry.reconnectGraceStartedAt);
    if (!Number.isFinite(disconnectedAt)) return false;
    const deadline = disconnectedAt + EDGE_CONNECTOR_RECONNECT_GRACE_MS;

    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      await delay(Math.max(1, Math.min(EDGE_CONNECTOR_RECONNECT_POLL_MS, remainingMs)));
      if (this.getExecutionReadyConnector(EDGE_PROTOCOL_VERSION) !== null) return true;
    }
    return false;
  }

  private async handleCompanionUpgrade(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_required" }, 426);
    }

    let runtime: EdgeControlPlaneRuntime;
    try {
      runtime = this.getControlRuntime();
    } catch (error) {
      if (error instanceof EdgeControlPlaneConfigurationError) {
        return jsonResponse({ error: "edge_control_plane_not_configured" }, 503);
      }
      throw error;
    }

    let principal: AuthenticatedEdgePrincipal;
    try {
      principal = await runtime.authenticator.authenticate(request);
    } catch (error) {
      if (error instanceof EdgeAuthenticationError) return error.toResponse();
      throw error;
    }
    if (!principal.userId) {
      return jsonResponse({ error: "individual_identity_required" }, 403);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      role: "companion",
      ready: false,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      userId: principal.userId,
    } satisfies CompanionAttachment);
    this.ctx.acceptWebSocket(server, ["companion"]);
    server.send(JSON.stringify({ type: "companion-hello", protocolVersion: COMPANION_PROTOCOL_VERSION }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleCompanionMessage(
    webSocket: WebSocket,
    message: string,
    attachment: CompanionAttachment,
  ): Promise<void> {
    const parsed = parseCompanionToEdgeMessage(message);
    if (!parsed) {
      webSocket.close(1008, "Invalid companion message");
      return;
    }

    if (parsed.type === "companion-ready") {
      let device;
      try {
        device = await this.accountStore.registerDevice(attachment.userId, {
          ...(parsed.registration.deviceId === undefined ? {} : { deviceId: parsed.registration.deviceId }),
          displayName: parsed.registration.displayName,
          platform: parsed.registration.platform,
        });
        const workspaceIds = new Set(parsed.workspaces.map((workspace) => workspace.workspaceId));
        for (const materialization of parsed.materializations) {
          if (!workspaceIds.has(materialization.workspaceId)) {
            throw new Error("Materialization references an unannounced workspace.");
          }
          await this.accountStore.upsertMaterialization(attachment.userId, device.id, {
            repositoryId: materialization.repositoryId,
            workspaceId: materialization.workspaceId,
            path: materialization.path,
            platform: parsed.registration.platform,
          });
        }
      } catch {
        webSocket.close(1008, "Companion registration rejected");
        return;
      }

      for (const candidate of this.ctx.getWebSockets("companion")) {
        if (candidate === webSocket) continue;
        const current = this.readCompanionAttachment(candidate);
        if (current?.deviceId === device.id && candidate.readyState === WebSocket.OPEN) {
          try { candidate.close(4000, "device reconnected"); } catch { /* already closing */ }
        }
      }

      webSocket.serializeAttachment({
        role: "companion",
        ready: true,
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        userId: attachment.userId,
        deviceId: device.id,
        displayName: device.displayName,
        platform: device.platform,
        capabilities: [...parsed.registration.capabilities],
        workspaces: parsed.workspaces.map((workspace) => ({ ...workspace, allowedShells: [...workspace.allowedShells] })),
      } satisfies CompanionAttachment);
      webSocket.send(JSON.stringify({
        type: "companion-registered",
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        deviceId: device.id,
      }));
      return;
    }

    const pending = this.pending.get(parsed.requestId);
    if (!pending || pending.connector !== webSocket) return;
    this.pending.delete(parsed.requestId);
    clearTimeout(pending.timeout);
    pending.releaseAbort();
    if (utf8ByteLength(parsed.body) > MAX_EDGE_RESPONSE_BODY_BYTES) {
      pending.resolve(jsonResponse({ error: "companion_response_too_large" }, 502));
      return;
    }
    const headers = collectAllowedResponseHeaders(parsed.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    pending.resolve(new Response(parsed.body, { status: parsed.status, headers }));
  }

  private readCompanionAttachment(webSocket: WebSocket): CompanionAttachment | null {
    const attachment = webSocket.deserializeAttachment();
    if (typeof attachment !== "object" || attachment === null ||
        !("role" in attachment) || attachment.role !== "companion" ||
        !("ready" in attachment) || typeof attachment.ready !== "boolean" ||
        !("protocolVersion" in attachment) || attachment.protocolVersion !== COMPANION_PROTOCOL_VERSION ||
        !("userId" in attachment) || typeof attachment.userId !== "string") return null;
    if ("deviceId" in attachment && attachment.deviceId !== undefined && typeof attachment.deviceId !== "string") return null;
    if ("displayName" in attachment && attachment.displayName !== undefined && typeof attachment.displayName !== "string") return null;
    if ("platform" in attachment && attachment.platform !== undefined &&
        attachment.platform !== "windows" && attachment.platform !== "linux" && attachment.platform !== "macos" && attachment.platform !== "unknown") return null;
    if ("capabilities" in attachment && attachment.capabilities !== undefined &&
        (!Array.isArray(attachment.capabilities) || !attachment.capabilities.every((entry: unknown) => typeof entry === "string"))) return null;
    if ("workspaces" in attachment && attachment.workspaces !== undefined && !Array.isArray(attachment.workspaces)) return null;
    return attachment as CompanionAttachment;
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
      this.pending.set(requestId, { resolve, timeout, releaseAbort, connector });
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
    const connector = this.getExecutionReadyConnector(EDGE_PROTOCOL_VERSION);
    if (!connector) return unavailableResponse?.() ?? jsonResponse({ error: "connector_unavailable" }, 503);
    return this.relayAuthenticatedRequestTo(
      request,
      body,
      principal,
      connector,
      EDGE_PROTOCOL_VERSION,
      unavailableResponse,
    );
  }

  private async relayAuthenticatedRequestTo(
    request: Request,
    body: string,
    principal: AuthenticatedEdgePrincipal,
    connector: WebSocket,
    protocolVersion: typeof EDGE_PROTOCOL_VERSION | typeof COMPANION_PROTOCOL_VERSION,
    unavailableResponse?: () => Response,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    if (!isAllowedEdgeRequest(request.method, path)) {
      return jsonResponse({ error: "edge_route_not_allowed" }, 404);
    }
    if (utf8ByteLength(body) > MAX_EDGE_REQUEST_BODY_BYTES) {
      return jsonResponse({ error: "request_too_large" }, 413);
    }

    const requestId = crypto.randomUUID();
    const envelope: EdgeHttpRequestMessage | CompanionHttpRequestMessage = {
      type: "http-request",
      protocolVersion,
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
        if (!pending || pending.connector !== connector) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.releaseAbort();
        this.sendCancellation(connector, requestId, reason, protocolVersion);
        resolve(response);
      };

      const timeout = setTimeout(() => {
        finishWithCancellation("timeout", jsonResponse({ error: protocolVersion === COMPANION_PROTOCOL_VERSION ? "companion_timeout" : "connector_timeout" }, 504));
      }, EDGE_RELAY_TIMEOUT_MS);
      const onAbort = () => finishWithCancellation("client_disconnected", new Response(null, { status: 499 }));
      request.signal.addEventListener("abort", onAbort, { once: true });
      const releaseAbort = () => request.signal.removeEventListener("abort", onAbort);

      this.pending.set(requestId, {
        resolve,
        timeout,
        releaseAbort,
        connector,
        ...(unavailableResponse === undefined ? {} : { unavailableResponse }),
      });

      if (protocolVersion === EDGE_PROTOCOL_VERSION) {
        this.updateConnectorTelemetry({ type: "request", at: new Date().toISOString(), requestId });
      }
      try {
        connector.send(JSON.stringify(envelope));
      } catch {
        clearTimeout(timeout);
        releaseAbort();
        this.pending.delete(requestId);
        resolve(unavailableResponse?.() ?? jsonResponse({ error: protocolVersion === COMPANION_PROTOCOL_VERSION ? "companion_send_failed" : "connector_send_failed" }, 503));
      }
    });
  }

  private sendCancellation(
    connector: WebSocket,
    requestId: string,
    reason: EdgeHttpCancelMessage["reason"],
    protocolVersion: 1 | 2 | 3,
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

  private selectReadyConnector(
    protocolVersion?: number,
    requireCompatible = false,
    closingCandidate?: { webSocket: WebSocket; attachment: ConnectorAttachment },
    requiredContractRevision?: string,
  ): WebSocket | null {
    let selected: WebSocket | null = null;
    let selectedAttachment: ConnectorAttachment | null = null;

    for (const webSocket of this.ctx.getWebSockets("connector")) {
      const isClosingCandidate = webSocket === closingCandidate?.webSocket;
      const attachment = isClosingCandidate
        ? closingCandidate.attachment
        : this.readConnectorAttachment(webSocket);
      if (attachment?.ready !== true ||
          (protocolVersion !== undefined && attachment.protocolVersion !== protocolVersion) ||
          (requireCompatible &&
            attachment.protocolVersion !== LEGACY_EDGE_PROTOCOL_VERSION &&
            attachment.contractCompatible !== true) ||
          (requiredContractRevision !== undefined &&
            attachment.protocolVersion !== LEGACY_EDGE_PROTOCOL_VERSION &&
            attachment.runtime?.catalogContractRevision !== requiredContractRevision) ||
          (!isClosingCandidate && webSocket.readyState !== WebSocket.OPEN)) {
        continue;
      }

      if (selected === null || selectedAttachment === null ||
          isPreferredConnectorAttachment(attachment, selectedAttachment)) {
        selected = webSocket;
        selectedAttachment = attachment;
      }
    }
    return selected;
  }

  private getReadyConnector(protocolVersion?: number): WebSocket | null {
    return this.selectReadyConnector(protocolVersion);
  }

  private getPreferredReadyConnector(): WebSocket | null {
    const v3 = this.getReadyConnector(EDGE_PROTOCOL_VERSION);
    const legacy = this.getReadyConnector(LEGACY_EDGE_PROTOCOL_VERSION);
    const protocol = selectPreferredConnectorProtocol(v3 !== null, legacy !== null);
    return protocol === EDGE_PROTOCOL_VERSION ? v3
      : protocol === LEGACY_EDGE_PROTOCOL_VERSION ? legacy
      : null;
  }

  private getExecutionReadyConnector(protocolVersion?: number): WebSocket | null {
    const requiredRevision = protocolVersion === LEGACY_EDGE_PROTOCOL_VERSION
      ? undefined
      : this.contractRolloutState.activeContractRevision;
    return this.selectReadyConnector(protocolVersion, true, undefined, requiredRevision);
  }

  private getReadyConnectorForContractRevision(revision: string): WebSocket | null {
    return this.selectReadyConnector(EDGE_PROTOCOL_VERSION, false, undefined, revision);
  }

  private getPreferredExecutionReadyConnector(
    closingCandidate?: { webSocket: WebSocket; attachment: ConnectorAttachment },
  ): WebSocket | null {
    const v3 = this.selectReadyConnector(
      EDGE_PROTOCOL_VERSION,
      true,
      closingCandidate,
      this.contractRolloutState.activeContractRevision,
    );
    const legacy = this.selectReadyConnector(LEGACY_EDGE_PROTOCOL_VERSION, true, closingCandidate);
    const protocol = selectPreferredConnectorProtocol(v3 !== null, legacy !== null);
    return protocol === EDGE_PROTOCOL_VERSION ? v3
      : protocol === LEGACY_EDGE_PROTOCOL_VERSION ? legacy
      : null;
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
      "contractCompatible" in attachment &&
      attachment.contractCompatible !== undefined &&
      typeof attachment.contractCompatible !== "boolean"
    ) return null;
    if (
      "runtime" in attachment &&
      attachment.runtime !== undefined &&
      !isConnectorRuntimeIdentity(attachment.runtime)
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
      ...("contractCompatible" in attachment && attachment.contractCompatible !== undefined
        ? { contractCompatible: attachment.contractCompatible as boolean }
        : {}),
      ...("runtime" in attachment && attachment.runtime !== undefined
        ? { runtime: attachment.runtime as ConnectorRuntimeIdentity }
        : {}),
      ...("disconnectRecorded" in attachment && attachment.disconnectRecorded !== undefined
        ? { disconnectRecorded: attachment.disconnectRecorded as boolean }
        : {}),
    };
  }

  private getExecutionReadyConnectorGeneration(): number | null {
    const connector = this.getExecutionReadyConnector(EDGE_PROTOCOL_VERSION);
    if (!connector) return null;
    return this.readConnectorAttachment(connector)?.connectionGeneration ?? null;
  }

  private refreshOpenConnectorContractCompatibility(): void {
    for (const webSocket of this.ctx.getWebSockets("connector")) {
      const attachment = this.readConnectorAttachment(webSocket);
      if (!attachment) continue;
      const contractCompatible = attachment.protocolVersion === LEGACY_EDGE_PROTOCOL_VERSION ||
        isConnectorContractCompatible(attachment.runtime, this.contractRolloutState);
      webSocket.serializeAttachment({
        ...attachment,
        contractCompatible,
      } satisfies ConnectorAttachment);
    }
  }

  private updateConnectorTelemetry(event: ConnectorTelemetryEvent): void {
    this.ctx.waitUntil(this.connectorTelemetry.record(event).then(() => undefined));
  }

  private recordConnectorDisconnect(
    webSocket: WebSocket,
    details: { source: "close" | "error"; closeCode?: number; wasClean?: boolean },
  ): void {
    const attachment = this.readConnectorAttachment(webSocket);
    if (!attachment || attachment.disconnectRecorded === true) return;
    const selectedBeforeDisconnect = this.getPreferredExecutionReadyConnector({
      webSocket,
      attachment,
    });
    const wasSelected = selectedBeforeDisconnect === webSocket;
    const wasReady = attachment.ready;
    webSocket.serializeAttachment({
      ...attachment,
      ready: false,
      disconnectRecorded: true,
    } satisfies ConnectorAttachment);
    if (!wasSelected) return;

    this.updateConnectorTelemetry({
      type: "disconnected",
      at: new Date().toISOString(),
      ...(attachment.connectionGeneration === undefined ? {} : { connectionGeneration: attachment.connectionGeneration }),
      wasReady,
      source: details.source,
      ...(details.closeCode === undefined ? {} : { closeCode: details.closeCode }),
      ...(details.wasClean === undefined ? {} : { wasClean: details.wasClean }),
    });

    const fallback = this.getPreferredExecutionReadyConnector();
    const fallbackRuntime = fallback ? this.readConnectorAttachment(fallback)?.runtime : undefined;
    if (fallback) {
      this.updateConnectorTelemetry({
        type: "ready",
        at: new Date().toISOString(),
        ...(fallbackRuntime === undefined ? {} : { runtime: fallbackRuntime }),
      });
    }
  }

  private failPendingRequestsForConnector(connector: WebSocket, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.connector !== connector) continue;
      clearTimeout(pending.timeout);
      pending.releaseAbort();
      pending.resolve(pending.unavailableResponse?.() ?? jsonResponse({ error: reason }, 503));
      this.pending.delete(requestId);
    }
  }
}

const COMPANION_LOCAL_REPOSITORY_TOOLS = new Set([
  "discover_local_repositories",
  "materialize_repository",
  "sync_repository",
]);

function isPreferredConnectorAttachment(
  candidate: ConnectorAttachment,
  current: ConnectorAttachment,
): boolean {
  if (candidate.protocolVersion !== EDGE_PROTOCOL_VERSION ||
      current.protocolVersion !== EDGE_PROTOCOL_VERSION) {
    return false;
  }
  return isPreferredConnectorRuntime(candidate.runtime, current.runtime);
}

function isConnectorRuntimeIdentity(value: unknown): value is ConnectorRuntimeIdentity {
  if (!isRecord(value)) return false;
  return value.version === 1 &&
    typeof value.connectorInstanceId === "string" &&
    Number.isSafeInteger(value.connectionGeneration) &&
    typeof value.processStartedAt === "string" &&
    typeof value.catalogContractRevision === "string" &&
    typeof value.toolSetRevision === "string" &&
    Number.isSafeInteger(value.toolCount) &&
    typeof value.serverVersion === "string" &&
    Number.isSafeInteger(value.nodePid) &&
    Number.isSafeInteger(value.hostPid);
}

type DiscoveredRepositoryEntry = {
  name: string;
  path: string;
  workspaceId: string;
  remoteUrls: string[];
  dirty: boolean;
};

type InternalRepositoryBinding = {
  repositoryId: string;
  name: string;
  path: string;
  workspaceId: string;
  remoteUrls: string[];
  managed: boolean;
};

type InternalBoundRepository = {
  repositoryId: string;
  workspaceId: string;
  path: string;
};

type WorkspaceListEntry = {
  id: string;
  name: string;
  workspaceKind?: "repository" | "aggregate";
  enabled: true;
  permissionProfile: string;
  confirmationMode: string;
  writesEnabled: boolean;
  shellsEnabled: boolean;
  allowedShells: string[];
};

function readMcpToolInvocation(value: unknown): { id: string | number | null; name: string; arguments: Record<string, unknown> } | null {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.method !== "tools/call" || !isRecord(value.params) || typeof value.params.name !== "string") return null;
  const args = value.params.arguments === undefined ? {} : isRecord(value.params.arguments) ? value.params.arguments : null;
  if (!args) return null;
  return {
    id: typeof value.id === "string" || typeof value.id === "number" ? value.id : null,
    name: value.params.name,
    arguments: args,
  };
}

async function readDiscoveredRepositoriesResponse(
  response: Response,
): Promise<DiscoveredRepositoryEntry[] | null> {
  const structured = await readMcpStructuredContent(response);
  if (!structured || !Array.isArray(structured.repositories)) return null;
  const repositories: DiscoveredRepositoryEntry[] = [];
  for (const value of structured.repositories) {
    if (!isRecord(value) ||
        typeof value.name !== "string" ||
        typeof value.path !== "string" ||
        typeof value.workspaceId !== "string" ||
        value.git !== true ||
        typeof value.dirty !== "boolean" ||
        !Array.isArray(value.remoteUrls) ||
        !value.remoteUrls.every((remote) => typeof remote === "string")) return null;
    repositories.push({
      name: value.name,
      path: value.path,
      workspaceId: value.workspaceId,
      remoteUrls: [...value.remoteUrls] as string[],
      dirty: value.dirty,
    });
  }
  return repositories;
}

async function readInternalBindingsResponse(
  response: Response,
): Promise<InternalBoundRepository[] | null> {
  const structured = await readMcpStructuredContent(response);
  if (!structured || !Array.isArray(structured.bound)) return null;
  const bound: InternalBoundRepository[] = [];
  for (const value of structured.bound) {
    if (!isRecord(value) ||
        typeof value.repositoryId !== "string" ||
        typeof value.workspaceId !== "string" ||
        typeof value.path !== "string") return null;
    bound.push({
      repositoryId: value.repositoryId,
      workspaceId: value.workspaceId,
      path: value.path,
    });
  }
  return bound;
}

async function readInternalMaterializationResponse(
  response: Response,
): Promise<InternalBoundRepository | null> {
  const structured = await readMcpStructuredContent(response);
  if (!structured || !isRecord(structured.materialization)) return null;
  const value = structured.materialization;
  if (typeof value.repositoryId !== "string" ||
      typeof value.workspaceId !== "string" ||
      typeof value.path !== "string") {
    return null;
  }
  return {
    repositoryId: value.repositoryId,
    workspaceId: value.workspaceId,
    path: value.path,
  };
}

async function readMcpStructuredContent(
  response: Response,
): Promise<Record<string, unknown> | null> {
  if (!response.ok) return null;
  let body: unknown;
  try { body = await response.json(); } catch { return null; }
  if (!isRecord(body) || !isRecord(body.result) || body.result.isError === true ||
      !isRecord(body.result.structuredContent)) return null;
  return body.result.structuredContent;
}

function browserAffinityKey(
  userId: string,
  kind: "tab" | "task",
  id: string,
): string {
  return `browser-affinity:v1:${userId}:${kind}:${encodeURIComponent(id)}`;
}

function collectBrowserAffinityIds(value: unknown): {
  tabIds: Set<string>;
  taskIds: Set<string>;
} {
  const tabIds = new Set<string>();
  const taskIds = new Set<string>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 8 || current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 256)) visit(item, depth + 1);
      return;
    }
    if (!isRecord(current)) return;
    if (typeof current.tabId === "string" && current.tabId.length <= 128) {
      tabIds.add(current.tabId);
    }
    if (typeof current.taskId === "string" && current.taskId.length <= 128) {
      taskIds.add(current.taskId);
    }
    for (const nested of Object.values(current)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return { tabIds, taskIds };
}

function companionPathKey(value: string, platform?: CompanionPlatform): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return platform === "windows"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function materializationRollbackKey(
  repositoryId: string,
  workspaceId: string,
): string {
  return `${repositoryId}\u0000${workspaceId}`;
}

function normalizedRepositoryDisplayName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function nextAvailableRepositoryName(baseName: string, usedNames: Set<string>): string {
  const base = baseName.trim().slice(0, 200) || "Repository";
  if (!usedNames.has(normalizedRepositoryDisplayName(base))) return base;
  for (let suffix = 2; suffix <= 4096; suffix += 1) {
    const marker = ` (${suffix})`;
    const candidate = `${base.slice(0, Math.max(1, 200 - marker.length))}${marker}`;
    if (!usedNames.has(normalizedRepositoryDisplayName(candidate))) return candidate;
  }
  throw new Error("Repository name space is exhausted.");
}

async function readWorkspaceListResponse(response: Response): Promise<WorkspaceListEntry[] | null> {
  if (!response.ok) return null;
  let body: unknown;
  try { body = await response.json(); } catch { return null; }
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.structuredContent) || !Array.isArray(body.result.structuredContent.workspaces)) return null;
  const workspaces: WorkspaceListEntry[] = [];
  for (const value of body.result.structuredContent.workspaces) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || value.enabled !== true ||
        typeof value.permissionProfile !== "string" || typeof value.confirmationMode !== "string" ||
        typeof value.writesEnabled !== "boolean" || typeof value.shellsEnabled !== "boolean" ||
        !Array.isArray(value.allowedShells) || !value.allowedShells.every((shell: unknown) => typeof shell === "string") ||
        (value.workspaceKind !== undefined && value.workspaceKind !== "repository" && value.workspaceKind !== "aggregate")) return null;
    workspaces.push({
      id: value.id,
      name: value.name,
      ...(value.workspaceKind === undefined ? {} : { workspaceKind: value.workspaceKind }),
      enabled: true,
      permissionProfile: value.permissionProfile,
      confirmationMode: value.confirmationMode,
      writesEnabled: value.writesEnabled,
      shellsEnabled: value.shellsEnabled,
      allowedShells: [...value.allowedShells] as string[],
    });
  }
  return workspaces;
}

function mcpToolSuccess(request: unknown, structuredContent: unknown): Response {
  const invocation = readMcpToolInvocation(request);
  return jsonResponse({
    jsonrpc: "2.0",
    id: invocation?.id ?? null,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  });
}

function mcpToolError(request: unknown, code: string, message: string): Response {
  const invocation = readMcpToolInvocation(request);
  return jsonResponse({
    jsonrpc: "2.0",
    id: invocation?.id ?? null,
    result: {
      isError: true,
      content: [{ type: "text", text: `${code}: ${message}` }],
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
