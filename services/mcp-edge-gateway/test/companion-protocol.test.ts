import { describe, expect, it } from "@jest/globals";
import {
  COMPANION_PROTOCOL_VERSION,
  parseCompanionToEdgeMessage,
  parseEdgeToCompanionMessage,
} from "@mcp-access-stack/edge-protocol";

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
