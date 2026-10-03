import { BROWSER_LATENCY_ID_HEADER, BROWSER_LATENCY_RELAY_HEADER, MAX_EDGE_REQUEST_BODY_BYTES, browserLatencyRequestInfo, isBrowserLatencyOperation, createBrowserLatencyRecorder } from "@mcp-access-stack/edge-protocol";

const record = createBrowserLatencyRecorder(e => console.log(JSON.stringify(e)), "edge");
// Called at the public HTTP boundary. Client-supplied correlation headers are replaced.
export async function measureEdgeMcpRequest(request: Request, dispatch: (request: Request) => Promise<Response>, entry?: { monotonic: number; wall: number }): Promise<Response> {
  const arrived = entry ?? { monotonic: performance.now(), wall: Date.now() };
  const requestInfo = await requestInfoFor(request);
  const operation = requestInfo.operation;
  if (!isBrowserLatencyOperation(operation)) return dispatch(request);
  const requestId = crypto.randomUUID();
  const measured = record({ requestId }, operation, arrived);
  const headers = new Headers(request.headers);
  headers.set(BROWSER_LATENCY_ID_HEADER, requestId);
  headers.delete(BROWSER_LATENCY_RELAY_HEADER);
  let response: Response | undefined;
  try {
    const dispatched = dispatch(new Request(request, { headers }));
    const mcpCallIdHashPromise = measured.enabled && requestInfo.jsonRpcId !== undefined
      ? hashMcpCallId(request.headers.get("mcp-session-id"), requestInfo.jsonRpcId) : undefined;
    if (mcpCallIdHashPromise) {
      const [routedResponse, mcpCallIdHash] = await Promise.all([dispatched, mcpCallIdHashPromise]);
      if (mcpCallIdHash) measured.addIds({ mcpCallIdHash });
      response = routedResponse;
    } else {
      response = await dispatched;
    }
    return response;
  } finally {
    measured.finish(request.signal.aborted ? "cancelled" : response?.ok ? "success" : "error",
      { responseStatus: response?.status });
  }
}

// Inspect a bounded clone so the existing dispatcher still owns the original body.
// Malformed/oversized input is handled by the existing request path, not diagnostics.
async function requestInfoFor(request: Request) {
  if (request.method !== "POST" || !request.body) return { operation: "mcp_http" };
  const reader = request.clone().body!.getReader();
  const decoder = new TextDecoder();
  let size = 0, body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return browserLatencyRequestInfo(body + decoder.decode());
      size += value.byteLength;
      if (size > MAX_EDGE_REQUEST_BODY_BYTES) return { operation: "mcp_http" };
      body += decoder.decode(value, { stream: true });
    }
  } catch { return { operation: "mcp_http" }; }
  finally {
    // Awaiting cancellation of one branch of a tee can block the other branch.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function hashMcpCallId(sessionId: string | null, jsonRpcId: string | number): Promise<string | undefined> {
  if (!sessionId || sessionId.length > 512) return undefined;
  try {
    const encoder = new TextEncoder();
    if (encoder.encode(sessionId).byteLength > 512) return undefined;
    const material = JSON.stringify(["mcp-browser-call:v1", sessionId, typeof jsonRpcId, jsonRpcId]);
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(material));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  } catch { return undefined; }
}
