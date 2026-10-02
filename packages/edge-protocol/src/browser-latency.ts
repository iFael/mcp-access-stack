// Internal diagnostic metadata only. Never pass tool arguments or response bodies here.
export const BROWSER_LATENCY_ID_HEADER = "x-mcp-browser-latency-id";
export const BROWSER_LATENCY_RELAY_HEADER = "x-mcp-browser-relay-id";
export const BROWSER_LATENCY_CAPTURE_LIMIT = 256;
export type BrowserLatencyIds = {
  requestId?: string; relayRequestId?: string; gatewayRequestId?: string;
  invocationId?: string; bridgeRequestId?: string;
};
// Exact public MCP names; the manifest parity test guards this list.
export const BROWSER_LATENCY_OPERATIONS = [
  "browser_status",
  "browser_connect",
  "browser_tabs",
  "browser_open",
  "browser_open_authorized_site",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_press",
  "browser_wait",
  "browser_extract",
  "browser_sequence",
  "browser_frame_extract",
  "browser_frame_click",
  "browser_frame_fill",
  "browser_profile_page",
  "browser_dom_index",
  "browser_frame_sequence",
  "browser_navigate_path",
  "browser_screenshot",
  "browser_go_back",
  "browser_go_forward",
  "browser_close_tab",
  "browser_finish_task",
  "browser_download",
  "browser_upload",
  "browser_console",
  "browser_network",
  "browser_trace",
  "browser_video",
  "browser_pdf",
  "browser_diagnostics",
] as const;
const browserTools: ReadonlySet<string> = new Set(BROWSER_LATENCY_OPERATIONS);
export function isBrowserLatencyOperation(operation: string): boolean {
  return browserTools.has(operation);
}
export function browserLatencyOperation(body: unknown): string {
  try {
    const value = (typeof body === "string" ? JSON.parse(body) : body) as { method?: unknown; params?: { name?: unknown } } | null;
    const name = value?.method === "tools/call" ? value.params?.name : undefined;
    return typeof name === "string" && isBrowserLatencyOperation(name) ? name : "mcp_http";
  } catch { return "mcp_http"; }
}
// These are internal BrowserOperation RPC names, never accepted as MCP tool aliases.
// Emit the corresponding canonical catalog name even at the bridge boundary.
const bridgeOperations: Readonly<Record<string, string>> = {
  status: "browser_status", connect: "browser_connect", tabs: "browser_tabs",
  open: "browser_open", openAuthorizedSite: "browser_open_authorized_site",
  navigate: "browser_navigate", snapshot: "browser_snapshot", click: "browser_click",
  fill: "browser_fill", press: "browser_press", wait: "browser_wait", extract: "browser_extract",
  sequence: "browser_sequence", frameExtract: "browser_frame_extract", frameClick: "browser_frame_click",
  frameFill: "browser_frame_fill", profilePage: "browser_profile_page", domIndex: "browser_dom_index",
  frameSequence: "browser_frame_sequence", navigatePath: "browser_navigate_path",
  screenshot: "browser_screenshot", goBack: "browser_go_back", goForward: "browser_go_forward",
  closeTab: "browser_close_tab", finishTask: "browser_finish_task", download: "browser_download",
  upload: "browser_upload", console: "browser_console", networkList: "browser_network",
  networkInspect: "browser_network", traceStart: "browser_trace", traceStop: "browser_trace",
  videoStart: "browser_video", videoStop: "browser_video", pdf: "browser_pdf", diagnostics: "browser_diagnostics",
};

type Layer = "edge" | "relay" | "oracle_connector" | "companion_connector" | "bridge";
type Outcome = "success" | "error" | "cancelled" | "timeout" | "closed";
const metrics = ["gatewayBeforeBridgeMs", "requestBytes", "responseBytes", "dispatchMs", "routingMs", "relayMs", "fetchMs",
  "responseReadMs", "responseStatus", "extensionReceivedAt", "extensionTotalMs", "extensionQueueMs",
  "extensionActionMs", "snapshotMs", "serializationMs"] as const;
export function latencyId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ? value : undefined;
}
// One bounded capture window per component lifetime; no retained requests or growing history.
export function createBrowserLatencyRecorder(log: (entry: Record<string, unknown>) => void, layer: Layer,
  limit = BROWSER_LATENCY_CAPTURE_LIMIT, clock = () => performance.now()) {
  let admitted = 0;
  const capacity = Number.isFinite(limit) ? Math.min(BROWSER_LATENCY_CAPTURE_LIMIT, Math.max(0, Math.floor(limit))) : 0;
  return (ids: BrowserLatencyIds, operation: string, entry?: { monotonic: number; wall: number }) => {
    const started = entry?.monotonic ?? clock(), startedAt = entry?.wall ?? Date.now();
    const safeOperation = isBrowserLatencyOperation(operation) ? operation
      : layer === "bridge" && Object.hasOwn(bridgeOperations, operation) ? bridgeOperations[operation] : undefined;
    const enabled = safeOperation !== undefined && admitted < capacity;
    if (enabled) admitted += 1;
    const captureIndex = admitted;
    let finished = false;
    const safeIds: Record<string, string> = {};
    for (const key of ["requestId", "relayRequestId", "gatewayRequestId", "invocationId", "bridgeRequestId"] as const) {
      const id = latencyId(ids[key]); if (id) safeIds[key] = id;
    }
    return {
      enabled,
      finish(outcome: Outcome, values: Record<string, unknown> = {}) {
        if (finished || !enabled) return;
        finished = true;
        const event: Record<string, unknown> = { event: "browser_latency", layer, ...safeIds,
          operation: safeOperation, stage: "terminal", outcome, captureIndex, captureLimit: capacity, startedAt, endedAt: Date.now(),
          durationMs: Math.max(0, Math.round((clock() - started) * 1000) / 1000) };
        for (const key of metrics) {
          const v = values[key];
          if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) event[key] = Math.round(v * 1000) / 1000;
        }
        // Producers supply only allowlisted AppError/transport codes, never exception messages.
        if (typeof values.errorCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(values.errorCode)) event.errorCode = values.errorCode;
        try { log(event); } catch { /* Diagnostics must not alter execution. */ }
      },
    };
  };
}
// The extension is a peer: whitelist, bound and validate timing independently of its result.
export function extensionLatencyMetrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const names = ["totalMs", "queueMs", "actionMs", "snapshotMs", "serializationMs"] as const;
  if (!names.every(k => typeof v[k] === "number" && Number.isFinite(v[k]) && (v[k] as number) >= 0 && (v[k] as number) <= 330000)) return {};
  if ((v.queueMs as number) + (v.actionMs as number) + (v.snapshotMs as number) + (v.serializationMs as number) > (v.totalMs as number) + 0.01) return {};
  const result = { extensionTotalMs: v.totalMs as number, extensionQueueMs: v.queueMs as number,
    extensionActionMs: v.actionMs as number, snapshotMs: v.snapshotMs as number, serializationMs: v.serializationMs as number };
  return typeof v.receivedAt === "number" && Number.isSafeInteger(v.receivedAt) && v.receivedAt > 0
    ? { ...result, extensionReceivedAt: v.receivedAt } : result;
}
