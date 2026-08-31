import { describe, expect, it } from "@jest/globals";
import {
  appendSessionDiagnostic,
  classifySessionDiagnostic,
  readSessionDiagnostics,
  shouldPersistSessionDiagnostic,
  type SessionDiagnosticStorage,
} from "../src/control-plane/session-diagnostics.js";

class MemoryStorage implements SessionDiagnosticStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
}

describe("session routing diagnostics", () => {
  it("records refresh invalid_grant without retaining raw credentials", async () => {
    const refreshToken = "refresh-super-secret-token-value";
    const event = await classifySessionDiagnostic(
      new Request("https://edge.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "chatgpt-client-123",
          refresh_token: refreshToken,
          resource: "https://edge.example/mcp",
        }),
      }),
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      1_788_150_000_000,
    );

    expect(event).toMatchObject({
      atMs: 1_788_150_000_000,
      route: "/token",
      httpMethod: "POST",
      status: 400,
      oauthGrantType: "refresh_token",
      oauthError: "invalid_grant",
    });
    expect(event.clientFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(event.credentialFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(refreshToken);
    expect(serialized).not.toContain("chatgpt-client-123");
  });

  it("correlates successful token rotation using fingerprints only", async () => {
    const presentedRefresh = "refresh-presented-secret";
    const issuedAccess = "issued-access-secret";
    const issuedRefresh = "issued-refresh-secret";
    const event = await classifySessionDiagnostic(
      new Request("https://edge.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "chatgpt-client-456",
          refresh_token: presentedRefresh,
        }),
      }),
      new Response(JSON.stringify({
        access_token: issuedAccess,
        token_type: "bearer",
        refresh_token: issuedRefresh,
      }), { status: 200, headers: { "content-type": "application/json" } }),
      1_788_150_000_002,
    );

    expect(event.credentialFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(event.issuedAccessFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(event.issuedCredentialFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(presentedRefresh);
    expect(serialized).not.toContain(issuedAccess);
    expect(serialized).not.toContain(issuedRefresh);
  });

  it("records MCP initialize and tools/list without request bodies or bearer tokens", async () => {
    const bearer = "very-secret-bearer-token";
    for (const method of ["initialize", "tools/list"] as const) {
      const event = await classifySessionDiagnostic(
        new Request("https://edge.example/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "initialize" ? { protocolVersion: "2025-06-18" } : {} }),
        }),
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        1_788_150_000_001,
      );

      expect(event).toMatchObject({ route: "/mcp", httpMethod: "POST", status: 200, mcpMethod: method });
      expect(event.credentialFingerprint).toMatch(/^[a-f0-9]{16}$/u);
      expect(JSON.stringify(event)).not.toContain(bearer);
    }
  });

  it("keeps handshake, OAuth and failures but drops successful tool-call noise", () => {
    const base = { version: 1 as const, atMs: 1, route: "/mcp", httpMethod: "POST", status: 200 };
    expect(shouldPersistSessionDiagnostic({ ...base, mcpMethod: "initialize" })).toBe(true);
    expect(shouldPersistSessionDiagnostic({ ...base, mcpMethod: "tools/list" })).toBe(true);
    expect(shouldPersistSessionDiagnostic({ ...base, mcpMethod: "tools/call" })).toBe(false);
    expect(shouldPersistSessionDiagnostic({ ...base, status: 401, mcpMethod: "tools/call" })).toBe(true);
    expect(shouldPersistSessionDiagnostic({ ...base, route: "/token", oauthGrantType: "refresh_token" })).toBe(true);
  });

  it("retains at most 128 recent events and removes entries older than 48 hours", async () => {
    const storage = new MemoryStorage();
    const now = 1_788_200_000_000;
    await appendSessionDiagnostic(storage, {
      version: 1, atMs: now - (49 * 60 * 60 * 1000), route: "/token", httpMethod: "POST", status: 200,
    });
    for (let index = 0; index < 130; index += 1) {
      await appendSessionDiagnostic(storage, {
        version: 1, atMs: now + index, route: "/mcp", httpMethod: "POST", status: 200, mcpMethod: "initialize",
      }, now + index);
    }
    const events = await readSessionDiagnostics(storage, now + 129);
    expect(events).toHaveLength(128);
    expect(events[0]?.atMs).toBe(now + 2);
    expect(events.some((entry) => entry.atMs < now)).toBe(false);
  });
});