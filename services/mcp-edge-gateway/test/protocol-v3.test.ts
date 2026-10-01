import { describe, expect, it } from "@jest/globals";
import {
  EDGE_PROTOCOL_VERSION,
  parseConnectorToEdgeMessage,
  parseEdgeToConnectorMessage,
} from "@mcp-access-stack/edge-protocol";
import { collectAllowedRequestHeaders } from "../src/protocol.js";

describe("Edge Protocol v3 authenticated execution envelope", () => {
  it("requires a sanitized authenticated principal on execution requests", () => {
    expect(EDGE_PROTOCOL_VERSION).toBe(3);

    const base = {
      type: "http-request",
      protocolVersion: 3,
      requestId: "request-1",
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: "Bearer public-token-must-not-be-trusted-downstream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    };

    expect(parseEdgeToConnectorMessage(JSON.stringify(base))).toBeNull();

    expect(parseEdgeToConnectorMessage(JSON.stringify({
      ...base,
      principal: {
        subject: "owner:test",
        scopes: ["mcp:tools"],
        ownerScope: "owner",
      },
    }))).toMatchObject({
      protocolVersion: 3,
      principal: {
        subject: "owner:test",
        scopes: ["mcp:tools"],
        ownerScope: "owner",
      },
    });
  });

  it("rejects malformed or credential-shaped principals fail-closed", () => {
    const envelope = (principal: unknown) => JSON.stringify({
      type: "http-request",
      protocolVersion: 3,
      requestId: "request-2",
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json" },
      body: "{}",
      principal,
    });

    for (const principal of [
      null,
      {},
      { subject: "", scopes: ["mcp:tools"] },
      { subject: "owner:test", scopes: [] },
      { subject: "owner:test", scopes: ["mcp:tools", "mcp:tools"] },
      { subject: "owner:test", scopes: ["mcp:tools"], ownerScope: 7 },
      { subject: "owner:test", scopes: ["mcp:tools"], token: "forbidden" },
      { subject: "owner:test", scopes: ["mcp:tools"], authorization: "forbidden" },
    ]) {
      expect(parseEdgeToConnectorMessage(envelope(principal))).toBeNull();
    }
  });

  it("keeps connector runtime identity backward compatible while carrying Browser epoch", () => {
    const runtime = {
      version: 1,
      connectorInstanceId: "11111111-1111-4111-8111-111111111111",
      connectionGeneration: 7,
      processStartedAt: "2026-09-30T12:00:00.000Z",
      catalogContractRevision: "a".repeat(64),
      toolSetRevision: "b".repeat(64),
      toolCount: 91,
      serverVersion: "1.1.0-test",
      nodePid: 100,
      hostPid: 99,
    };
    const ready = (activeRuntime: Record<string, unknown>) => JSON.stringify({
      type: "connector-ready",
      protocolVersion: 3,
      runtime: activeRuntime,
    });

    expect(parseConnectorToEdgeMessage(ready(runtime))).toMatchObject({
      type: "connector-ready",
      runtime,
    });

    const browserEpoch = "22222222-2222-4222-8222-222222222222";
    expect(parseConnectorToEdgeMessage(ready({ ...runtime, browserEpoch }))).toMatchObject({
      type: "connector-ready",
      runtime: { ...runtime, browserEpoch },
    });

    expect(parseConnectorToEdgeMessage(ready({
      ...runtime,
      browserEpoch: "not-a-uuid",
    }))).toBeNull();
  });

  it("strips public credentials while preserving the opaque ChatGPT session identity", () => {
    const headers = new Headers({
      authorization: "Bearer public-token",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": "session-1",
      origin: "https://chatgpt.com",
      "x-openai-session": "chat-session-1",
      "x-openai-subject": "chat-subject-1",
      "x-mcp-edge-internal-assertion": "caller-controlled",
      "x-other-secret": "caller-controlled",
    });

    expect(collectAllowedRequestHeaders(headers)).toEqual({
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": "session-1",
      origin: "https://chatgpt.com",
      "x-openai-session": "chat-session-1",
      "x-openai-subject": "chat-subject-1",
    });
  });
});
