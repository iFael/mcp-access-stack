import { describe, expect, it } from "@jest/globals";
import {
  EDGE_PROTOCOL_VERSION,
  parseEdgeToConnectorMessage,
} from "@mcp-access-stack/edge-protocol/source";
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

  it("strips public credentials and reserved internal assertions from execution headers", () => {
    const headers = new Headers({
      authorization: "Bearer public-token",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": "session-1",
      origin: "https://chatgpt.com",
      "x-mcp-edge-internal-assertion": "caller-controlled",
      "x-other-secret": "caller-controlled",
    });

    expect(collectAllowedRequestHeaders(headers)).toEqual({
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": "session-1",
      origin: "https://chatgpt.com",
    });
  });});
