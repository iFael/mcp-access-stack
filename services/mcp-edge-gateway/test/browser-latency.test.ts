import { describe, expect, it, jest } from "@jest/globals";
import { createBrowserLatencyRecorder, extensionLatencyMetrics, latencyId, browserLatencyOperation, browserLatencyRequestInfo, BROWSER_LATENCY_OPERATIONS, BROWSER_LATENCY_ID_HEADER, BROWSER_LATENCY_RELAY_HEADER } from "@mcp-access-stack/edge-protocol";
import { measureEdgeMcpRequest } from "../src/browser-latency.js";
import { EDGE_MCP_TOOL_MANIFEST } from "../src/generated/mcp-tool-manifest.js";
import { browserOperationSchema } from "@vs-code-gpt/shared";
const browserBody = JSON.stringify({ jsonrpc: "2.0", id: "private-request-id", method: "tools/call", params: { name: "browser_fill", arguments: { value: "secret-body" } } });
const id = "11111111-1111-4111-8111-111111111111";
describe("bounded browser latency", () => {
  it("matches the exact canonical public Browser catalog and maps bridge RPCs to that catalog", () => {
    const canonical = EDGE_MCP_TOOL_MANIFEST.map(t => t.name).filter(name => name.startsWith("browser_"));
    expect([...BROWSER_LATENCY_OPERATIONS].sort()).toEqual([...canonical].sort());
    expect(new Set(BROWSER_LATENCY_OPERATIONS).size).toBe(BROWSER_LATENCY_OPERATIONS.length);
    for (const tool of EDGE_MCP_TOOL_MANIFEST) {
      const body = { method: "tools/call", params: { name: tool.name } };
      expect(browserLatencyOperation(body)).toBe(canonical.includes(tool.name) ? tool.name : "mcp_http");
      expect(browserLatencyOperation(JSON.stringify(body))).toBe(browserLatencyOperation(body));
    }
    for (const name of ["fill", "tabs", "console", "trace", "video", "browser_network_list", "browser_trace_start", "mcp_http"]) {
      expect(browserLatencyOperation(JSON.stringify({ method: "tools/call", params: { name } }))).toBe("mcp_http");
    }
    for (const body of [null, "invalid JSON", [], { method: "tools/list", params: { name: "browser_fill" } }, { method: "initialize" }]) expect(browserLatencyOperation(body)).toBe("mcp_http");
    expect(browserLatencyRequestInfo({ jsonrpc: "2.0", id: "call-42", method: "tools/call", params: { name: "browser_fill" } }))
      .toEqual({ operation: "browser_fill", jsonRpcId: "call-42" });
    expect(browserLatencyRequestInfo({ jsonrpc: "2.0", id: "x".repeat(257), method: "tools/call", params: { name: "browser_fill" } }))
      .toEqual({ operation: "browser_fill" });
    expect(browserLatencyRequestInfo({ jsonrpc: "2.0", id: "é".repeat(129), method: "tools/call", params: { name: "browser_fill" } }))
      .toEqual({ operation: "browser_fill" });
    expect(browserLatencyRequestInfo({ jsonrpc: "2.0", id: "call-42", method: "tools/call", params: { name: "list_devices" } }))
      .toEqual({ operation: "mcp_http" });
    const events: Record<string, unknown>[] = [];
    const bridge = createBrowserLatencyRecorder(e => events.push(e), "bridge");
    for (const operation of browserOperationSchema.options) bridge({}, operation).finish("success");
    expect(events).toHaveLength(browserOperationSchema.options.length);
    expect(events.every(event => canonical.includes(event.operation as string))).toBe(true);
    expect(events.find(event => event.operation === "browser_fill")).toBeDefined();
  });
  it.each(["edge", "relay", "oracle_connector", "companion_connector"] as const)("reserves all 256 Browser admissions after hundreds of non-Browser calls at %s", layer => {
    const events: Record<string, unknown>[] = [];
    const record = createBrowserLatencyRecorder(e => events.push(e), layer);
    for (let n = 0; n < 600; n++) {
      for (const operation of ["mcp_http", "fill", "tabs", "goBack", "console", "trace", "video", "browser_trace_start", "list_devices"]) {
        const capture = record({ requestId: id }, operation);
        expect(capture.enabled).toBe(false);
        capture.finish("success");
      }
    }
    expect(events).toHaveLength(0);
    for (let n = 0; n < 256; n++) record({ requestId: id }, "browser_fill").finish("success");
    expect(events).toHaveLength(256);
    expect(events[0]).toMatchObject({ operation: "browser_fill", captureIndex: 1, captureLimit: 256 });
    expect(record({ requestId: id }, "browser_fill").enabled).toBe(false);
  });
  it("does not spend the public Edge window on initialize, tools/list or non-Browser tools", async () => {
    await jest.isolateModulesAsync(async () => {
      const { measureEdgeMcpRequest: measure } = await import("../src/browser-latency.js");
      const spy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      const bodies = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_devices", arguments: {} } },
      ];
      let dispatched = 0;
      const dispatch = async (request: Request) => { await request.text(); dispatched += 1; return new Response("ok"); };
      try {
        for (let n = 0; n < 600; n++) await measure(new Request("https://edge.example/mcp", { method: "POST", body: JSON.stringify(bodies[n % bodies.length]) }), dispatch);
        expect(dispatched).toBe(600);
        expect(spy).not.toHaveBeenCalled();
        const body = JSON.stringify({ method: "tools/call", params: { name: "browser_fill", arguments: { value: "private draft" } } });
        for (let n = 0; n < 257; n++) await measure(new Request("https://edge.example/mcp", { method: "POST", body }), dispatch);
        expect(dispatched).toBe(857);
        expect(spy).toHaveBeenCalledTimes(256);
        expect(JSON.parse(spy.mock.calls[0]![0] as string)).toMatchObject({ operation: "browser_fill", captureIndex: 1 });
        expect(JSON.stringify(spy.mock.calls)).not.toContain("private draft");
      } finally { spy.mockRestore(); }
    });
  });
  it("includes the public handler entry before route selection in the Edge total", async () => {
    const spy=jest.spyOn(console,"log").mockImplementation(() => undefined);
    const entry={ monotonic:performance.now()-10, wall:Date.now()-10 };
    const measure=measureEdgeMcpRequest as (request:Request, dispatch:(r:Request)=>Promise<Response>, entry:{monotonic:number;wall:number})=>Promise<Response>;
    try {
      await measure(new Request("https://edge.example/mcp", { method: "POST", body: browserBody }), async () => new Response("ok"), entry);
      const event=JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string,unknown>;
      expect(event.startedAt).toBe(entry.wall);
      expect(event.durationMs as number).toBeGreaterThanOrEqual(10);
    } finally { spy.mockRestore(); }
  });
  it("logs one bounded terminal per admission, drops private fields and rejects invalid numeric/identity data", () => {
    const events: Record<string, unknown>[] = []; let clock = 10;
    const record = createBrowserLatencyRecorder(e => events.push(e), "relay", 2, () => clock);
    const first = record({ requestId: id, bridgeRequestId: "secret-identity" }, "browser_fill");
    first.addIds({ mcpCallIdHash: "a".repeat(64) });
    clock = 15;
    first.finish("success", { requestBytes: 100, responseBytes: Infinity, actionMs: -1, value: "secret-fill", token: "secret-token", contentBase64: "secret-image" });
    first.finish("error");
    record({ requestId: id }, "browser_sequence").finish("cancelled");
    record({ requestId: id }, "browser_sequence").finish("success");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ requestId: id, mcpCallIdHash: "a".repeat(64), durationMs: 5, requestBytes: 100, operation: "browser_fill" });
    expect(events[0]).not.toHaveProperty("value");
    expect(events[1]).toMatchObject({ durationMs: 0, outcome: "cancelled" });
    expect(JSON.stringify(events)).not.toMatch(/secret|Infinity|Base64/);
    expect(JSON.stringify(events[0]).length).toBeLessThan(2048);
    expect(latencyId("a".repeat(100000))).toBeUndefined();
    const bounded: unknown[] = [];
    const cap = createBrowserLatencyRecorder(e => bounded.push(e), "relay", 1000000);
    for (let n=0;n<1000;n++) cap({ requestId: id }, "browser_sequence").finish("success");
    expect(bounded).toHaveLength(256);
  });
  it("never lets a diagnostic sink failure alter execution and clamps backwards clocks", () => {
    let clock=10;
    const measured=createBrowserLatencyRecorder(() => { throw Error("sink unavailable"); }, "bridge", 1, () => clock)({ requestId:id }, "fill");
    clock=0; expect(() => measured.finish("error")).not.toThrow();
  });
  it("rejects incoherent peer measurements and never copies peer content", () => {
    expect(extensionLatencyMetrics({ totalMs: 1, queueMs: 2, actionMs: 0, snapshotMs: 0, serializationMs: 0 })).toEqual({});
    expect(extensionLatencyMetrics({ totalMs: 1, queueMs: NaN, actionMs: 0, snapshotMs: 0, serializationMs: 0 })).toEqual({});
    expect(extensionLatencyMetrics({ totalMs: 330001, queueMs: 0, actionMs: 0, snapshotMs: 0, serializationMs: 0 })).toEqual({});
    expect(extensionLatencyMetrics({ totalMs: 10, queueMs: 1, actionMs: 3, snapshotMs: 4, serializationMs: 1, content: "secret" })).toEqual({ extensionTotalMs: 10, extensionQueueMs: 1, extensionActionMs: 3, snapshotMs: 4, serializationMs: 1 });
  });
  it("replaces spoofed caller IDs, preserves the HTTP body, and records public Edge entry through response", async () => {
    const spy=jest.spyOn(console,"log").mockImplementation(() => undefined);
    let routedId: string | undefined;
    try {
      const response=await measureEdgeMcpRequest(new Request("https://edge.example/mcp", { method:"POST",
        headers: { [BROWSER_LATENCY_ID_HEADER]:id, [BROWSER_LATENCY_RELAY_HEADER]:id, authorization:"Bearer secret-token" }, body:browserBody }), async r => {
        routedId=r.headers.get(BROWSER_LATENCY_ID_HEADER) ?? undefined;
        expect(latencyId(routedId)).toBe(routedId);
        expect(routedId).not.toBe(id);
        expect(r.headers.has(BROWSER_LATENCY_RELAY_HEADER)).toBe(false);
        expect(await r.text()).toBe(browserBody);
        return new Response("secret-response");
      });
      expect(await response.text()).toBe("secret-response");
      const event=JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(event).toMatchObject({ layer:"edge",requestId:routedId,outcome:"success",stage:"terminal" });
      expect(event.durationMs as number).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
    } finally { spy.mockRestore(); }
  });
  it("correlates a bounded MCP call ID to the Edge root and downstream relay ID without logging raw values", async () => {
    const spy=jest.spyOn(console,"log").mockImplementation(() => undefined);
    const sessionId="private-session-id-7";
    const jsonRpcId="work-mcp-request-83";
    const rawBody=JSON.stringify({ jsonrpc:"2.0", id:jsonRpcId, method:"tools/call",
      params:{ name:"browser_fill", arguments:{ ref:"private-ref", value:"private-draft" } } });
    let edgeRootId: string | undefined;
    const relayEvents: Record<string, unknown>[]=[];
    try {
      await measureEdgeMcpRequest(new Request("https://edge.example/mcp", { method:"POST",
        headers:{ "mcp-session-id":sessionId }, body:rawBody }), async routed => {
        edgeRootId=routed.headers.get(BROWSER_LATENCY_ID_HEADER) ?? undefined;
        const relay=createBrowserLatencyRecorder(event=>relayEvents.push(event),"relay");
        relay({ requestId:edgeRootId, relayRequestId:id },"browser_fill").finish("success");
        return new Response("ok");
      });
      const edgeEvent=JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string,unknown>;
      const expectedHashBuffer=await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(JSON.stringify(["mcp-browser-call:v1",sessionId,typeof jsonRpcId,jsonRpcId])));
      const expectedHash=Array.from(new Uint8Array(expectedHashBuffer), byte=>byte.toString(16).padStart(2,"0")).join("");
      expect(edgeEvent).toMatchObject({ layer:"edge",requestId:edgeRootId,mcpCallIdHash:expectedHash });
      expect(latencyId(edgeRootId)).toBe(edgeRootId);
      expect(relayEvents[0]).toMatchObject({ requestId:edgeRootId,relayRequestId:id });
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/private-session-id-7|work-mcp-request-83|private-ref|private-draft/);
    } finally { spy.mockRestore(); }
  });
  it("omits the MCP call hash when no bounded session ID is available", async () => {
    const spy=jest.spyOn(console,"log").mockImplementation(() => undefined);
    try {
      await measureEdgeMcpRequest(new Request("https://edge.example/mcp", { method:"POST", body:browserBody }), async () => new Response("ok"));
      const event=JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string,unknown>;
      expect(event).not.toHaveProperty("mcpCallIdHash");
    } finally { spy.mockRestore(); }
  });
  it("records a terminal when Edge dispatch fails", async () => {
    const spy=jest.spyOn(console,"log").mockImplementation(() => undefined);
    try {
      await expect(measureEdgeMcpRequest(new Request("https://edge.example/mcp", { method: "POST", body: browserBody }), async () => { throw Error("secret-diagnostic"); })).rejects.toThrow("secret-diagnostic");
      expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({ outcome:"error",stage:"terminal" });
      expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
    } finally { spy.mockRestore(); }
  });
});
