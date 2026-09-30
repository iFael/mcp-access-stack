export type BrowserRuntimeAffinity = {
  version: 3;
  runtimeId: string;
  browserEpoch: string;
};

export type BrowserRemoteRuntime = {
  runtimeId: string;
  online: boolean;
  browserEpoch?: string;
};

export type BrowserRouteDecision =
  | { kind: "remote" }
  | { kind: "companion"; deviceId: string }
  | { kind: "primary-default" }
  | { kind: "error"; code: string; message: string };

export interface BrowserRouteSelectionInput {
  requestedDeviceId?: string;
  requestedRuntimeId?: string;
  affinityDeviceId?: string;
  affinityRuntime?: BrowserRuntimeAffinity;
  remote: BrowserRemoteRuntime;
  companionDeviceIds: readonly string[];
}

export function selectBrowserExecutionRoute(
  input: BrowserRouteSelectionInput,
): BrowserRouteDecision {
  if (input.requestedDeviceId && input.requestedRuntimeId) {
    return error(
      "BROWSER_ROUTE_CONFLICT",
      "Choose either deviceId or runtimeId for a browser operation, not both.",
    );
  }

  if (input.affinityRuntime) {
    if (input.affinityDeviceId) {
      return error(
        "BROWSER_ROUTE_CONFLICT",
        "Browser tab/task affinity points to different MCP V3 runtimes.",
      );
    }
    if (input.requestedDeviceId) {
      return error(
        "BROWSER_ROUTE_CONFLICT",
        "Requested device conflicts with the existing remote browser affinity.",
      );
    }
    if (input.requestedRuntimeId &&
        input.requestedRuntimeId !== input.affinityRuntime.runtimeId) {
      return error(
        "BROWSER_ROUTE_CONFLICT",
        "Requested runtime conflicts with the existing remote browser affinity.",
      );
    }
    if (!input.remote.online) {
      return error(
        "AGENT_UNAVAILABLE",
        "The MCP V3 remote runtime owning this browser context is not online.",
      );
    }
    if (!input.remote.browserEpoch) {
      return error(
        "BROWSER_WORKER_UNAVAILABLE",
        "The MCP V3 remote Browser runtime is unavailable.",
      );
    }
    if (input.remote.runtimeId !== input.affinityRuntime.runtimeId ||
        input.remote.browserEpoch !== input.affinityRuntime.browserEpoch) {
      return error(
        "BROWSER_SESSION_STALE",
        "The remote Browser session was recreated; this task/tab reference is stale.",
      );
    }
    return { kind: "remote" };
  }

  if (input.affinityDeviceId) {
    if (input.requestedRuntimeId) {
      return error(
        "BROWSER_ROUTE_CONFLICT",
        "Requested runtime conflicts with the existing companion browser affinity.",
      );
    }
    if (input.requestedDeviceId &&
        input.requestedDeviceId !== input.affinityDeviceId) {
      return error(
        "BROWSER_ROUTE_CONFLICT",
        "Requested device conflicts with the existing browser tab/task affinity.",
      );
    }
    return input.companionDeviceIds.includes(input.affinityDeviceId)
      ? { kind: "companion", deviceId: input.affinityDeviceId }
      : error(
          "AGENT_UNAVAILABLE",
          "The MCP V3 device owning this browser context is not online.",
        );
  }

  if (input.requestedRuntimeId) {
    if (input.requestedRuntimeId !== input.remote.runtimeId) {
      return error(
        "RUNTIME_UNAVAILABLE",
        "The requested MCP V3 remote runtime is not available in this account session.",
      );
    }
    if (!input.remote.online) {
      return error(
        "AGENT_UNAVAILABLE",
        "The requested MCP V3 remote runtime is not online.",
      );
    }
    if (!input.remote.browserEpoch) {
      return error(
        "BROWSER_WORKER_UNAVAILABLE",
        "The requested MCP V3 remote runtime does not currently expose Browser capability.",
      );
    }
    return { kind: "remote" };
  }

  if (input.requestedDeviceId) {
    return input.companionDeviceIds.includes(input.requestedDeviceId)
      ? { kind: "companion", deviceId: input.requestedDeviceId }
      : error(
          "AGENT_UNAVAILABLE",
          "The MCP V3 device selected for this browser operation is not online.",
        );
  }

  if (input.companionDeviceIds.length === 0) {
    return { kind: "primary-default" };
  }
  if (input.companionDeviceIds.length === 1) {
    return { kind: "companion", deviceId: input.companionDeviceIds[0]! };
  }
  return error(
    "DEVICE_SELECTION_REQUIRED",
    "More than one browser-capable MCP V3 device is online; choose deviceId or runtimeId.",
  );
}

export function readBrowserRuntimeAffinity(
  value: unknown,
): BrowserRuntimeAffinity | null {
  if (!isRecord(value) ||
      value.version !== 3 ||
      typeof value.runtimeId !== "string" ||
      !/^rt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.runtimeId) ||
      typeof value.browserEpoch !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.browserEpoch)) {
    return null;
  }
  return {
    version: 3,
    runtimeId: value.runtimeId,
    browserEpoch: value.browserEpoch,
  };
}

export function browserRuntimeAffinityKey(
  userId: string,
  kind: "tab" | "task",
  id: string,
): string {
  return `browser-affinity:v3:${userId}:${kind}:${encodeURIComponent(id)}`;
}

function error(code: string, message: string): BrowserRouteDecision {
  return { kind: "error", code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
