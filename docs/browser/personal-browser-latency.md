# Personal Browser latency diagnostics

The implementation adds internal correlation and a bounded diagnostic capture. It does not change public MCP input/output schemas, BrowserModeRouter selection, browser behavior, deadlines, ownership, mutation queues, capabilities or screenshot imageContent.

## Identity and observable boundaries

The public Edge /mcp boundary creates an internal requestId and overwrites caller-supplied correlation headers. Each relay keeps its existing requestId as relayRequestId. The connector forwards those IDs through private loopback headers. The gateway keeps its existing HTTP requestId as gatewayRequestId and the operation factory keeps its existing invocationId. PersonalBrowserBridge keeps its existing WebSocket RPC id as bridgeRequestId. The extension response is matched by that RPC id and connection generation; timing is read only from the matched response.

The latency object on OperationContext is in-process TypeScript metadata. It is deliberately absent from the public Zod and relay operation schemas. No caller supplies tracing arguments. No telemetry is added to public tool results.

For a personal tab bound to deviceId, the actual route is Edge -> companion connector on Windows -> local gateway -> PersonalBrowserBridge -> Chrome extension. Oracle is not automatically in this path. The Oracle connector is instrumented for requests which actually use the primary runtime. Missing Oracle events on a direct companion route are expected.

| Event | Measurements |
| --- | --- |
| browser_latency, layer=edge | Public Edge entry timestamp, end timestamp, HTTP boundary duration and status. Includes dispatch to the Durable Object and response processing. |
| browser_latency, layer=relay | relayRequestId, elapsed Durable Object entry-to-dispatch (routingMs when the same Request is available), dispatch-to-response (relayMs), request/response body UTF-8 bytes, HTTP status, terminal outcome. |
| browser_latency, layer=oracle_connector or companion_connector | Receipt timestamp, local fetch-to-headers (fetchMs), headers-to-body (responseReadMs), response JSON serialization (serializationMs), body bytes, HTTP status, total through WebSocket response dispatch. |
| Existing mcp_http_request_* events | Local HTTP requestId, latencyRequestId, relayRequestId, receipt timestamp, existing local duration; Content-Length sizes only when valid/available. |
| browser_latency, layer=bridge | Invocation/RPC/HTTP IDs, gatewayBeforeBridgeMs from the existing same-process monotonic HTTP start, bridge-to-WebSocket dispatch time, wire bytes, total through result validation or terminal failure. |
| Fixed timing on internal extension response | Extension receipt wall timestamp, per-request mutation queue wait, action duration excluding final snapshot, final snapshot duration, response JSON serialization, total through primary result serialization. Bridge exposes these as extension* fields, snapshotMs and serializationMs in its private log. |

Every duration uses a monotonic process clock. Wall timestamps are correlation anchors, not proof that clocks across machines are synchronized. HTTP success means successful transport; semantic Browser success/error is reported by the bridge.

## Bounds and privacy

Each new recorder admits at most 256 canonical Browser tools/call operations per component lifetime and emits at most one terminal event for each admission. initialize, tools/list, unknown tool names and non-Browser tools do not spend this window at Edge, relay, connectors or gateway. The gateway arrival middleware runs before express.json, so its normal start log remains intact and Browser admission occurs once at terminal logging using the parsed body; receipt timestamps still refer to HTTP arrival. The first 256 Browser terminal logs receive latency fields, then normal lifecycle logging continues without those fields. Internal bridge RPC names are mapped only at the bridge to exact public catalog names; they are never accepted as generic MCP tool aliases. The manifest parity test guards the canonical operation list. captureIndex/captureLimit identify the finite window. After the window, new events stop and bridge requests stop requesting extension timing. Existing log sinks/lifecycle logs remain in place; no new log history, file, database, service or dependency is created. New events have a fixed set of scalar fields (under 2 KiB), UUID-only identity fields, canonical operation names, finite nonnegative numbers and codes supplied from validated technical errors. Typed values, arguments, DOM text, URLs, user messages, auth headers, tokens and screenshot data never enter the recorder. Extension metrics are independently whitelisted and rejected if incoherent or outside the deadline bound.

Cancellation, deadlines, disconnects, invalid results and peer errors preserve their original functional semantics. A terminal is emitted exactly once within the admitted capture window. Diagnostic sink errors do not affect the operation. No shared current-request/timing variable is used in the extension; each request owns its accumulator.

## Explicitly unobservable subdivisions

- Before the HTTP request enters the public Edge: Work/host deliberation, tool dispatch, approvals and transport are outside this server's clocks.
- After Edge returns to Work: client/network/host response processing is outside this server's clocks.
- WebSocket one-way delay and transport queue residence cannot be separated from request/response measurements. Relay minus connector duration is a residual, not a measured queue. Bridge minus extension duration is also a residual.
- Separate authentication versus individual Durable Object storage lookups is not captured: these are included in Edge/routing totals. No routing behavior is changed to produce cleaner measurements.
- routingMs is omitted for an internal synthetic Request without the original entry stamp; it is not reported as zero.
- Missing Content-Length is not a zero-byte response. HTTP payload sizes exclude headers/framing; bridge sizes include its JSON envelope.
- Extension total includes receipt, parsing, queue, action, snapshot and primary response serialization. The tiny timing suffix encoding, WebSocket enqueue and network return are outside the extension total and remain in the bridge residual.
- An old loaded extension may ignore measureTiming. Missing extension metrics do not imply zero action/snapshot duration. Confirm timing fields after updating/reloading only the MCP V3 extension.

## Real benchmark protocol

Run against an officially activated instrumented release, with telemetry capture still admitted. Do not report a beta.77 call as an instrumented call. Obtain logs from existing authenticated/operator channels; do not make direct HTTP calls to bypass MCP browser tools.

1. Open one new task-scoped personal tab through the exposed MCP V3 browser_open tool, using the same public page/controller as the previous benchmark.
2. Observe via browser_snapshot and select the input from its current returned ref.
3. Execute at least five sequential browser_sequence calls, one neutral fill each, finalSnapshot=true, without sleeps, reusing the current ref returned by each final snapshot. Measure each caller call start/end using the caller's available clock; record its resolution. Do not send the draft.
4. Correlate server events by the root UUID, relay UUID, local HTTP UUID, invocation UUID and RPC UUID. If the Work host hides transport metadata, pairing caller samples to Edge entry windows is temporal inference and must be labeled; internal layer correlation remains exact.
5. Compare nested durations, never sum them. Report caller total, Edge total, routing, relay, connector, local HTTP, gatewayBeforeBridge, bridge, extension queue/action/snapshot/serialization. Outside-Edge = caller minus Edge is a combined before-and-after residual. Separate pre-Edge and return only with independently verified clock/window evidence.
6. Finish only this task using its exact taskId and keepOpen=true, and retain the five samples plus aggregate median/p95/total. Stop before implementing a bottleneck correction.

Baseline supplied by the user: median MCP fill+observation 4562 ms; five calls total 25006 ms; corresponding local HTTP total 989.559 ms; approximately 96.04% outside the local HTTP segment. These are previous measurements, not a post-instrumentation result.
