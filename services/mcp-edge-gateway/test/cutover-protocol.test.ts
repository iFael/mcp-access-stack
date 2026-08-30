import { describe, expect, it } from "@jest/globals";
import * as protocol from "../src/protocol.js";

const cutover = protocol as unknown as {
  resolveConnectorProtocol(url: URL, cutoverComplete: boolean): 2 | 3 | null;
  parseLegacyConnectorToEdgeMessage(value: string): Record<string, unknown> | null;
  collectLegacyAllowedRequestHeaders(headers: Headers): Record<string, string>;
};

describe("temporary connector v2 -> v3 cutover bridge", () => {
  it("accepts unqualified v2 only before cutover and requires explicit v3 thereafter", () => {
    expect(cutover.resolveConnectorProtocol(new URL("https://edge.example/connector"), false)).toBe(2);
    expect(cutover.resolveConnectorProtocol(new URL("https://edge.example/connector?protocol=3"), false)).toBe(3);
    expect(cutover.resolveConnectorProtocol(new URL("https://edge.example/connector"), true)).toBeNull();
    expect(cutover.resolveConnectorProtocol(new URL("https://edge.example/connector?protocol=3"), true)).toBe(3);
    expect(cutover.resolveConnectorProtocol(new URL("https://edge.example/connector?protocol=2"), false)).toBeNull();
  });

  it("parses only the bounded legacy response envelope and forwards authorization only on that path", () => {
    expect(cutover.parseLegacyConnectorToEdgeMessage(JSON.stringify({
      type: "connector-ready",
      protocolVersion: 2,
    }))).toEqual({ type: "connector-ready", protocolVersion: 2 });
    expect(cutover.parseLegacyConnectorToEdgeMessage(JSON.stringify({
      type: "http-response",
      protocolVersion: 2,
      requestId: "legacy-1",
      status: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
    }))).toEqual({
      type: "http-response",
      protocolVersion: 2,
      requestId: "legacy-1",
      status: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(cutover.parseLegacyConnectorToEdgeMessage(JSON.stringify({
      type: "http-response",
      protocolVersion: 3,
      requestId: "legacy-1",
      status: 200,
      body: "{}",
    }))).toBeNull();

    const headers = cutover.collectLegacyAllowedRequestHeaders(new Headers({
      authorization: "Bearer existing-chatgpt-token",
      "content-type": "application/json",
      origin: "https://chatgpt.com",
      "x-edge-secret": "must-not-cross",
    }));
    expect(headers).toEqual({
      authorization: "Bearer existing-chatgpt-token",
      "content-type": "application/json",
      origin: "https://chatgpt.com",
    });
  });
});
