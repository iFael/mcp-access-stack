import { BROWSER_LATENCY_ID_HEADER, BROWSER_LATENCY_RELAY_HEADER, MAX_EDGE_REQUEST_BODY_BYTES, browserLatencyOperation, isBrowserLatencyOperation, createBrowserLatencyRecorder } from "@mcp-access-stack/edge-protocol";

const record = createBrowserLatencyRecorder(e => console.log(JSON.stringify(e)), "edge");
// Called at the public HTTP boundary. Client-supplied correlation headers are replaced.
export async function measureEdgeMcpRequest(request: Request, dispatch: (request: Request) => Promise<Response>, entry?: { monotonic: number; wall: number }): Promise<Response> {
  const arrived = entry ?? { monotonic: performance.now(), wall: Date.now() };
  const operation = await requestOperation(request);
  if (!isBrowserLatencyOperation(operation)) return dispatch(request);
  const requestId = crypto.randomUUID();
  const measured = record({ requestId }, operation, arrived);
  const headers = new Headers(request.headers);
  headers.set(BROWSER_LATENCY_ID_HEADER, requestId);
  headers.delete(BROWSER_LATENCY_RELAY_HEADER);
  let response: Response | undefined;
  try {
    response = await dispatch(new Request(request, { headers }));
    return response;
  } finally {
    measured.finish(request.signal.aborted ? "cancelled" : response?.ok ? "success" : "error",
      { responseStatus: response?.status });
  }
}

// Inspect a bounded clone so the existing dispatcher still owns the original body.
// Malformed/oversized input is handled by the existing request path, not diagnostics.
async function requestOperation(request: Request): Promise<string> {
  if (request.method !== "POST" || !request.body) return "mcp_http";
  const reader = request.clone().body!.getReader();
  const decoder = new TextDecoder();
  let size = 0, body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return browserLatencyOperation(body + decoder.decode());
      size += value.byteLength;
      if (size > MAX_EDGE_REQUEST_BODY_BYTES) return "mcp_http";
      body += decoder.decode(value, { stream: true });
    }
  } catch { return "mcp_http"; }
  finally {
    // Awaiting cancellation of one branch of a tee can block the other branch.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
