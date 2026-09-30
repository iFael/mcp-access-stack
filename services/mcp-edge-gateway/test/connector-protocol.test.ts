import { describe, expect, it } from "@jest/globals";
import { EDGE_PROTOCOL_VERSION, resolveConnectorProtocol } from "../src/protocol.js";

describe("connector protocol", () => {
  it("requires the explicit current protocol version", () => {
    expect(resolveConnectorProtocol(new URL("https://edge.example/connector?protocol=3"))).toBe(
      EDGE_PROTOCOL_VERSION,
    );
    expect(resolveConnectorProtocol(new URL("https://edge.example/connector"))).toBeNull();
    expect(resolveConnectorProtocol(new URL("https://edge.example/connector?protocol=2"))).toBeNull();
  });

  it("rejects ambiguous or malformed connector URLs", () => {
    expect(
      resolveConnectorProtocol(
        new URL("https://edge.example/connector?protocol=3&extra=1"),
      ),
    ).toBeNull();
    expect(
      resolveConnectorProtocol(
        new URL("https://edge.example/connector?protocol=3#fragment"),
      ),
    ).toBeNull();
    expect(resolveConnectorProtocol(new URL("https://edge.example/other?protocol=3"))).toBeNull();
  });
});
