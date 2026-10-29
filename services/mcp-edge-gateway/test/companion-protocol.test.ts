import { describe, expect, it } from "@jest/globals";
import {
  COMPANION_PROTOCOL_VERSION,
  EDGE_PROTOCOL_VERSION,
  parseCompanionToEdgeMessage,
  parseConnectorToEdgeMessage,
  parseEdgeToCompanionMessage,
  parseEdgeToConnectorMessage,
} from "@mcp-access-stack/edge-protocol";

describe("wake events from the execution node", () => {
  const event = { kind: "task", taskId: "0f8fad5b-d9cb-469f-a165-70867728950e", workspaceId: "mcp-access-stack",
    state: "failed", exitCode: 1 };

  it("travel from the connector to the Edge and from the Edge to a companion", () => {
    expect(parseConnectorToEdgeMessage(JSON.stringify({ type: "connector-wake-event", protocolVersion: EDGE_PROTOCOL_VERSION, event })))
      .toEqual({ type: "connector-wake-event", protocolVersion: EDGE_PROTOCOL_VERSION, event });
    expect(parseEdgeToCompanionMessage(JSON.stringify({ type: "companion-wake-event", protocolVersion: COMPANION_PROTOCOL_VERSION, event })))
      .toEqual({ type: "companion-wake-event", protocolVersion: COMPANION_PROTOCOL_VERSION, event });
    expect(parseEdgeToConnectorMessage(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION, features: ["wakeEventsV1", "x"] })))
      .toEqual({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION, features: ["wakeEventsV1"] });
    expect(parseEdgeToConnectorMessage(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION })))
      .toEqual({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION });
  });

  it("include the end of an MCP update, which only an Edge that offers updateWakeV1 is told", () => {
    const update = { kind: "update", updateId: "upd_00000000-0000-4000-8000-000000000001", workspaceId: "mcp-access-stack", state: "failed" };
    expect(parseConnectorToEdgeMessage(JSON.stringify({ type: "connector-wake-event", protocolVersion: EDGE_PROTOCOL_VERSION, event: update })))
      .toEqual({ type: "connector-wake-event", protocolVersion: EDGE_PROTOCOL_VERSION, event: update });
    expect(parseConnectorToEdgeMessage(JSON.stringify({ type: "connector-wake-event", protocolVersion: EDGE_PROTOCOL_VERSION,
      event: { ...update, state: "running" } }))).toBeNull();
    expect(parseEdgeToConnectorMessage(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION,
      features: ["updateWakeV1"] }))).toEqual({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION, features: ["updateWakeV1"] });
  });

  it("carry only ids, names and states", () => {
    const bad = (value: Record<string, unknown>) =>
      parseConnectorToEdgeMessage(JSON.stringify({ type: "connector-wake-event", protocolVersion: EDGE_PROTOCOL_VERSION, event: value }));
    expect(bad({ ...event, state: "running" })).toBeNull();
    expect(bad({ ...event, taskId: "a b" })).toBeNull();
    expect(bad({ kind: "checks", watchId: "w1", workspaceId: "ws", repository: "o/r", commitSha: "short", state: "passed" })).toBeNull();
    expect(bad({ kind: "shell", workspaceId: "ws" })).toBeNull();
  });
});

describe("steps of a long operation on a runtime", () => {
  const update = { planId: "plan_00000000-0000-4000-8000-000000000001", title: "Atualizar o MCP",
    steps: [{ text: "Catálogo do Edge", state: "skipped" }, { text: "Release do conector", state: "doing" }] };

  it("travel from the connector and from a companion to the Edge, once the Edge offers progressV1", () => {
    expect(parseConnectorToEdgeMessage(JSON.stringify({ type: "connector-progress", protocolVersion: EDGE_PROTOCOL_VERSION, update })))
      .toEqual({ type: "connector-progress", protocolVersion: EDGE_PROTOCOL_VERSION, update });
    expect(parseCompanionToEdgeMessage(JSON.stringify({ type: "companion-progress", protocolVersion: COMPANION_PROTOCOL_VERSION, update })))
      .toEqual({ type: "companion-progress", protocolVersion: COMPANION_PROTOCOL_VERSION, update });
    expect(parseEdgeToConnectorMessage(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION,
      features: ["progressV1", "wakeEventsV1"] })))
      .toEqual({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION, features: ["wakeEventsV1", "progressV1"] });
    expect(parseEdgeToCompanionMessage(JSON.stringify({ type: "companion-registered", protocolVersion: COMPANION_PROTOCOL_VERSION,
      deviceId: "dev_00000000-0000-4000-8000-000000000001", features: ["userMessagesV1", "progressV1"] })))
      .toMatchObject({ features: ["userMessagesV1", "progressV1"] });
  });

  it("carry only a plan of the agent's shape", () => {
    const bad = (value: Record<string, unknown>) =>
      parseConnectorToEdgeMessage(JSON.stringify({ type: "connector-progress", protocolVersion: EDGE_PROTOCOL_VERSION, update: value }));
    expect(bad({ ...update, planId: "plan_x" })).toBeNull();
    expect(bad({ ...update, steps: [] })).toBeNull();
    expect(bad({ ...update, steps: [{ text: "a", state: "late" }] })).toBeNull();
    expect(bad({ ...update, steps: [{ text: "a", state: "done", log: "x" }] })).toBeNull();
    expect(bad({ ...update, owner: "user_1" })).toBeNull();
  });
});

describe("MCP V3 companion protocol", () => {
  it("accepts a valid companion registration and rejects duplicate workspace ids", () => {
    const valid = JSON.stringify({
      type: "companion-ready",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      registration: {
        displayName: "PC Trabalho",
        platform: "windows",
        capabilities: ["files", "terminal", "git"],
      },
      workspaces: [{
        workspaceId: "repo-local-1",
        name: "Projeto",
        workspaceKind: "repository",
        enabled: true,
        permissionProfile: "full-repo-write",
        confirmationMode: "trusted-workspace",
        writesEnabled: true,
        shellsEnabled: true,
        allowedShells: ["pwsh"],
      }],
      materializations: [],
    });
    expect(parseCompanionToEdgeMessage(valid)).toMatchObject({
      type: "companion-ready",
      registration: { displayName: "PC Trabalho", platform: "windows" },
    });

    const duplicate = JSON.stringify({
      ...JSON.parse(valid),
      workspaces: [
        JSON.parse(valid).workspaces[0],
        JSON.parse(valid).workspaces[0],
      ],
    });
    expect(parseCompanionToEdgeMessage(duplicate)).toBeNull();
  });

  it("parses companion heartbeat envelopes strictly", () => {
    expect(parseCompanionToEdgeMessage(JSON.stringify({
      type: "companion-heartbeat",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      heartbeatId: "42",
    }))).toEqual({
      type: "companion-heartbeat",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      heartbeatId: "42",
    });
    expect(parseEdgeToCompanionMessage(JSON.stringify({
      type: "companion-heartbeat-ack",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      heartbeatId: "42",
    }))).toEqual({
      type: "companion-heartbeat-ack",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      heartbeatId: "42",
    });
    expect(parseCompanionToEdgeMessage(JSON.stringify({
      type: "companion-heartbeat",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      heartbeatId: "bad heartbeat",
    }))).toBeNull();
  });

  it("negotiates popup message counts only with an Edge that offers them", () => {
    const registered = (extra: Record<string, unknown>) => parseEdgeToCompanionMessage(JSON.stringify({
      type: "companion-registered",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      deviceId: "dev_00000000-0000-4000-8000-000000000000",
      ...extra,
    }));
    expect(registered({ features: ["userMessagesV1", "future"] })).toMatchObject({ features: ["userMessagesV1"] });
    expect(registered({})).not.toHaveProperty("features");
    expect(parseCompanionToEdgeMessage(JSON.stringify({
      type: "companion-user-messages",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      pending: 2,
    }))).toEqual({ type: "companion-user-messages", protocolVersion: COMPANION_PROTOCOL_VERSION, pending: 2 });
    for (const pending of [-1, 1.5, "2", 1_001]) {
      expect(parseCompanionToEdgeMessage(JSON.stringify({
        type: "companion-user-messages",
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        pending,
      }))).toBeNull();
    }
  });

  it("keeps authenticated principals strict on companion execution requests", () => {
    const base = {
      type: "http-request",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      requestId: "req-1",
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    expect(parseEdgeToCompanionMessage(JSON.stringify({
      ...base,
      principal: {
        subject: "user:usr_00000000-0000-4000-8000-000000000001",
        scopes: ["workspaces:read"],
        ownerScope: "owner",
        userId: "usr_00000000-0000-4000-8000-000000000001",
      },
    }))).toMatchObject({
      type: "http-request",
      principal: { userId: "usr_00000000-0000-4000-8000-000000000001" },
    });

    expect(parseEdgeToCompanionMessage(JSON.stringify({
      ...base,
      principal: {
        subject: "user:test",
        scopes: ["workspaces:read"],
        userId: "not-a-user-id",
      },
    }))).toBeNull();
  });
});

describe("the Windows half of an MCP update", () => {
  const request = { updateId: "upd_00000000-0000-4000-8000-000000000001", tag: "v1.1.0-companion.4242" };
  const status = { updateId: request.updateId, phase: "prepare", state: "needs_confirmation",
    confirmation: { confirmationId: "cnf_1", reasons: ["new companion"], expiresAt: "2026-10-29T04:00:00.000Z" } };

  it("goes from the connector through the Edge to a companion, and its answer back", () => {
    expect(parseConnectorToEdgeMessage(JSON.stringify({ type: "connector-companion-update", protocolVersion: EDGE_PROTOCOL_VERSION, request })))
      .toEqual({ type: "connector-companion-update", protocolVersion: EDGE_PROTOCOL_VERSION, request });
    expect(parseEdgeToCompanionMessage(JSON.stringify({ type: "companion-update-request", protocolVersion: COMPANION_PROTOCOL_VERSION,
      request: { ...request, confirmationId: "cnf_1" } })))
      .toEqual({ type: "companion-update-request", protocolVersion: COMPANION_PROTOCOL_VERSION, request: { ...request, confirmationId: "cnf_1" } });
    expect(parseCompanionToEdgeMessage(JSON.stringify({ type: "companion-update-status", protocolVersion: COMPANION_PROTOCOL_VERSION, status })))
      .toEqual({ type: "companion-update-status", protocolVersion: COMPANION_PROTOCOL_VERSION, status });
    expect(parseEdgeToConnectorMessage(JSON.stringify({ type: "edge-companion-update-status", protocolVersion: EDGE_PROTOCOL_VERSION, status })))
      .toEqual({ type: "edge-companion-update-status", protocolVersion: EDGE_PROTOCOL_VERSION, status });
    expect(parseEdgeToConnectorMessage(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION,
      features: ["companionUpdateV1"] }))).toMatchObject({ features: ["companionUpdateV1"] });
    expect(parseEdgeToCompanionMessage(JSON.stringify({ type: "companion-registered", protocolVersion: COMPANION_PROTOCOL_VERSION,
      deviceId: "dev_00000000-0000-4000-8000-000000000001", features: ["companionUpdateV1"] })))
      .toMatchObject({ features: ["companionUpdateV1"] });
  });

  it("names only a companion release, and answers only in its own shape", () => {
    const ask = (value: Record<string, unknown>) =>
      parseConnectorToEdgeMessage(JSON.stringify({ type: "connector-companion-update", protocolVersion: EDGE_PROTOCOL_VERSION, request: value }));
    expect(ask({ ...request, tag: "v1.1.0-beta.103-connector.1" })).toBeNull();
    expect(ask({ ...request, tag: "v1.1.0-companion.1; rm" })).toBeNull();
    expect(ask({ ...request, command: "x" })).toBeNull();
    const answer = (value: Record<string, unknown>) =>
      parseCompanionToEdgeMessage(JSON.stringify({ type: "companion-update-status", protocolVersion: COMPANION_PROTOCOL_VERSION, status: value }));
    expect(answer({ ...status, phase: "verify" })).toBeNull();
    expect(answer({ ...status, error: { code: "lower", message: "x" } })).toBeNull();
    expect(answer({ ...status, log: "x" })).toBeNull();
  });
});
