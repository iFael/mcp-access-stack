# MCP Session Materialization Reliability

## Scope

This document defines the repository-side observability contract for MCP session materialization incidents and the external product-layer continuity semantics required from ChatGPT.

The `mcp-access-stack` can make connector, Edge, execution and catalog state deterministic and observable. It cannot persist, rebind or rematerialize ChatGPT's internal session tool registry. Repository telemetry must therefore be used to distinguish a server/runtime failure from a call that never reached the Edge.

## Repository-side runtime identity

A V3 `connector-ready` message may carry a versioned runtime identity:

```text
version
connectorInstanceId
connectionGeneration
processStartedAt
catalogContractRevision
toolSetRevision
toolCount
serverVersion
nodePid
hostPid
```

`connectorInstanceId` is generated once per connector Node process. Reconnects keep the same instance ID and increment `connectionGeneration`. A process restart produces a new instance ID.

Catalog identity is derived from the existing canonical catalog functions. Reconnect or process restart must not change contract revision, tool-set revision or server version when descriptors and tool names are unchanged.

## Edge telemetry

The Durable Object persists connector lifecycle and relay evidence under a versioned record. The record contains:

- connector instance and connection generation;
- process and catalog identity;
- `readySince` and `lastDisconnectedAt`;
- `lastRequestAt` and `lastSuccessfulRequestAt`;
- `lastRequestId`;
- ready/disconnect/request/success counters.

Telemetry intentionally excludes request bodies, authorization headers, OAuth credentials, connector tokens and owner tokens.

A request counter is incremented only immediately before an Edge HTTP request is sent to the connector. A success counter is incremented only after a valid connector response resolves the pending relay. Therefore:

```text
attempted invocation
+ lastRequestAt/count unchanged
= invocation did not reach the Edge relay
```

while:

```text
lastRequestAt/count advanced
+ success count unchanged
= invocation reached Edge but did not complete successfully below Edge
```

## Public and authenticated observability

`GET /health` exposes only safe continuity data:

- connector instance ID;
- connection generation;
- catalog contract/tool-set/server identity;
- ready timestamp;
- last request/success timestamps;
- ready/disconnect counts.

Public health does not expose local PIDs or request IDs.

`GET /_internal/session-diagnostics` remains protected by the existing connector-token authentication and adds the full runtime telemetry record, including `nodePid`, `hostPid`, `lastRequestId`, relay counters and timestamps.

## Read-only incident evidence collector

`deploy/windows/Get-McpMaterializationIncidentEvidence.ps1` collects one JSON document without changing host or runtime state. It reads the canonical Edge Connector Scheduled Task, process tree, immutable release identity, public health and authenticated session diagnostics.

The collector:

- reads the connector token only from the configured token file;
- uses the token only in memory for the authenticated diagnostics request;
- never writes token contents, authorization headers or request bodies to evidence;
- performs no task restart, task registration, process kill, service change, release mutation or antivirus action;
- reports missing process state instead of attempting recovery;
- fails clearly if the Scheduled Task is missing or authenticated diagnostics cannot be obtained.

The evidence contains UTC/local timestamps, Scheduled Task state/action/working directory, release ID/path, McpEdgeHost and bundled Node process evidence, `/health`, detailed `runtimeTelemetry`, Edge request/success counters and connector/catalog identity.

## Incident interpretation

The strongest repository-side isolation for the known session incident is:

```text
ChatGPT session reports a materialized tool as disabled or unavailable
+ /health reports all expected planes ready
+ connectorInstanceId is unchanged
+ disconnectCount is unchanged
+ lastRequestAt and relayedRequestCount do not advance at the attempted invocation time
= the invocation did not reach MCP/Edge; failure is strongly isolated above the repository transport layer
```

A changed connector instance or increased disconnect count instead points to connector lifecycle activity and must be investigated before attributing the incident to ChatGPT session materialization.

## Catalog immutability per MCP server instance

For one `createMcpServer()` instance:

```text
serverVersion
contractRevision
toolSetRevision
descriptorRevision
```

are immutable publication identity.

Repeated `tools/list` calls must return the same identity when the registered catalog is unchanged. If tool names or descriptors are mutated after server construction, publication fails closed rather than silently presenting a new catalog under the existing server identity.

## External ChatGPT continuity contract

The product-layer lifecycle is conceptually:

```text
DISCOVERED -> MATERIALIZED -> BOUND -> INVOKABLE
```

A transient failure in one stage must not be converted into permanent namespace disablement.

For a stale binding or `resource not found` before dispatch, the required product behavior is:

```text
stale binding / resource not found
-> mark binding STALE
-> rediscover namespace
-> compare catalog identity
-> atomically rebind the session tool
-> retry one read-only invocation
```

The rebind decision should use the server/catalog identity returned by discovery. If identity is unchanged, the product may restore the binding without treating the namespace as a different tool contract.

For mutations, automatic replay is not generally safe:

```text
stale binding after dispatch uncertainty
-> reconcile persisted outcome
-> retry only when execution is proven not started or replay is otherwise proven safe
```

The repository must not implement blind retry for mutations with ambiguous outcomes.

Permanent namespace disablement is appropriate only for explicit permanent states such as:

- user/app disablement;
- policy denial;
- permanent authorization revocation.

A transient resolver, discovery, materialization or binding failure must remain recoverable and must not silently become a permanent session-level disable.

## Error taxonomy

Keep these classes distinct in diagnostics and incident reports:

- **tool not materialized**: the session has no usable materialized tool entry;
- **stale binding**: a materialized entry references an invalid/expired resource binding;
- **namespace disabled by policy/user**: explicit product state prevents invocation;
- **rematerialization failed**: rediscovery/rebinding could not restore the session entry;
- **MCP transport unavailable**: request cannot reach or maintain the MCP transport/connector path;
- **execution backend unavailable**: Edge/control-plane is reachable, but the execution backend reports `AGENT_UNAVAILABLE`;
- **capability unsupported**: the requested execution mode/operation is outside the current runner capability;
- **operation timeout/failure**: the operation was dispatched but exceeded its deadline or returned a concrete execution failure.

These classes must not be collapsed into a generic "MCP offline" diagnosis.

## Closure boundary

Repository hardening is complete when server-side gates are green, runtime identity and telemetry are observable, the catalog remains immutable per server instance, and the collector can prove whether an attempted call reached Edge.

That does **not** prove the ChatGPT session registry itself is fixed. If a materialized tool is disabled before any matching Edge request arrives, the remaining defect is external to `mcp-access-stack` and should be retained as a product-layer known issue with timestamped evidence.
