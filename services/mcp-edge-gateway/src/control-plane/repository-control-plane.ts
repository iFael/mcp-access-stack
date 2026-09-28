import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import { EdgeAccountStore, type StoredDevice, type StoredMaterialization, type StoredRepository } from "./account-store.js";

export interface RepositoryPresence {
  isDeviceOnline(deviceId: string): boolean;
  disconnectDevice?(deviceId: string): void;
}

export interface EdgeLocalMcpToolHandler {
  handle(body: unknown, principal: AuthenticatedEdgePrincipal): Promise<Response | null>;
}

export class EdgeRepositoryControlPlane implements EdgeLocalMcpToolHandler {
  constructor(
    private readonly accounts: EdgeAccountStore,
    private readonly presence: RepositoryPresence,
  ) {}

  async handle(body: unknown, principal: AuthenticatedEdgePrincipal): Promise<Response | null> {
    const request = parseToolCall(body);
    if (!request || !CLOUD_REPOSITORY_TOOLS.has(request.name)) return null;
    if (!principal.userId) {
      return toolError(request.id, "IDENTITY_REQUIRED", "Reconnect MCP V3 and select an individual user profile before accessing private repositories.");
    }
    try {
      return await this.dispatch(request, principal.userId);
    } catch (error) {
      return toolError(request.id, "REPOSITORY_OPERATION_FAILED", error instanceof Error ? error.message : "Repository operation failed.");
    }
  }

  private async dispatch(request: ToolCall, userId: string): Promise<Response> {
    switch (request.name) {
      case "get_onboarding_state": return this.getOnboardingState(request.id, userId);
      case "list_repositories": return this.listRepositories(request.id, userId);
      case "get_repository": return this.getRepository(request.id, userId, request.arguments);
      case "create_repository": return this.createRepository(request.id, userId, request.arguments);
      case "list_devices": return this.listDevices(request.id, userId);
      case "revoke_device": return this.revokeDevice(request.id, userId, request.arguments);
      default: return toolError(request.id, "METHOD_NOT_FOUND", "Repository operation is not supported.");
    }
  }

  private async getOnboardingState(id: JsonRpcId, userId: string): Promise<Response> {
    const user = await this.accounts.getUser(userId);
    if (!user) return toolError(id, "IDENTITY_REQUIRED", "Authenticated user profile no longer exists.");
    const repositories = await this.accounts.listRepositories(userId);
    const devices = await this.accounts.listDevices(userId);
    const visibleDevices = devices.map((device) => this.deviceSummary(device));
    return toolSuccess(id, {
      user: { id: user.id, displayName: user.displayName },
      repositoryCount: repositories.length,
      devices: visibleDevices,
      status: visibleDevices.some((device) => device.status === "online") ? "ready" : "device_required",
    });
  }

  private async listRepositories(id: JsonRpcId, userId: string): Promise<Response> {
    const records = await this.accounts.listRepositories(userId);
    return toolSuccess(id, {
      repositories: records.map(({ repository, role }) => repositorySummary(repository, role)),
    });
  }

  private async getRepository(id: JsonRpcId, userId: string, args: Record<string, unknown>): Promise<Response> {
    const repositoryId = readIdArg(args, "repositoryId", "repo_");
    const details = await this.readRepositoryDetails(userId, repositoryId);
    if (!details) return toolError(id, "REPOSITORY_NOT_FOUND", "Repository is not available to this user.");
    return toolSuccess(id, details);
  }

  async readRepositoryDetails(userId: string, repositoryId: string) {
    const access = await this.accounts.getRepositoryForUser(userId, repositoryId);
    if (!access) return null;
    const materializations = await this.accounts.listMaterializations(userId, repositoryId);
    return {
      ...repositorySummary(access.repository, access.role),
      materializations: materializations.map((value) => this.materializationSummary(value)),
    };
  }

  private async createRepository(id: JsonRpcId, userId: string, args: Record<string, unknown>): Promise<Response> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return toolError(id, "INVALID_ARGUMENT", "Repository name is required.");
    const repository = await this.accounts.createRepository(userId, name);
    return toolSuccess(id, { ...repositorySummary(repository, "owner"), materializations: [] });
  }

  private async listDevices(id: JsonRpcId, userId: string): Promise<Response> {
    const devices = await this.accounts.listDevices(userId);
    return toolSuccess(id, { devices: devices.map((device) => this.deviceSummary(device)) });
  }

  private async revokeDevice(id: JsonRpcId, userId: string, args: Record<string, unknown>): Promise<Response> {
    const deviceId = readIdArg(args, "deviceId", "dev_");
    const device = await this.accounts.revokeDevice(userId, deviceId);
    if (!device) return toolError(id, "DEVICE_NOT_FOUND", "Device is not available to this user.");
    this.presence.disconnectDevice?.(deviceId);
    return toolSuccess(id, { device: this.deviceSummary(device) });
  }

  private deviceSummary(device: StoredDevice) {
    const status = device.revokedAt ? "revoked" as const : this.presence.isDeviceOnline(device.id) ? "online" as const : "offline" as const;
    return {
      id: device.id,
      displayName: device.displayName,
      platform: device.platform,
      status,
      createdAt: device.createdAt,
      ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }),
    };
  }

  private materializationSummary(value: StoredMaterialization) {
    return {
      id: value.id,
      repositoryId: value.repositoryId,
      deviceId: value.deviceId,
      workspaceId: value.workspaceId,
      platform: value.platform,
      path: value.path,
      status: this.presence.isDeviceOnline(value.deviceId) ? "online" as const : "offline" as const,
    };
  }
}

const CLOUD_REPOSITORY_TOOLS = new Set([
  "get_onboarding_state",
  "list_repositories",
  "get_repository",
  "create_repository",
  "list_devices",
  "revoke_device",
]);

type JsonRpcId = string | number | null;
type ToolCall = { id: JsonRpcId; name: string; arguments: Record<string, unknown> };

function parseToolCall(value: unknown): ToolCall | null {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.method !== "tools/call") return null;
  if (!isRecord(value.params) || typeof value.params.name !== "string") return null;
  const args = value.params.arguments === undefined ? {} : isRecord(value.params.arguments) ? value.params.arguments : null;
  if (!args) return null;
  return {
    id: typeof value.id === "string" || typeof value.id === "number" ? value.id : null,
    name: value.params.name,
    arguments: args,
  };
}

function repositorySummary(repository: StoredRepository, role: "owner" | "editor" | "viewer") {
  return {
    id: repository.id,
    name: repository.name,
    role,
    visibility: repository.visibility,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}

function readIdArg(args: Record<string, unknown>, name: string, prefix: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length > 64) throw new Error(`${name} is invalid.`);
  return value;
}

function toolSuccess(id: JsonRpcId, structuredContent: unknown): Response {
  return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent });
}

function toolError(id: JsonRpcId, code: string, message: string): Response {
  return rpcResult(id, { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] });
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
