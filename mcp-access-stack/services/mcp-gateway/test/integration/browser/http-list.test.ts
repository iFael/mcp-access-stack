import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it } from "@jest/globals";
import { createGatewayApplication } from "../../../src/app.js";
import { listen, makeGatewayConfig, silentLogger } from "../../support/helpers.js";

const validAuth: AuthInfo = {
  token: "valid",
  clientId: "browser-tools-http-list-test",
  scopes: ["workspaces:read"],
  expiresAt: Math.floor(Date.now() / 1_000) + 300,
  extra: { subject: "allowed-user" },
};

const advancedToolNames = [
  "browser_console",
  "browser_network",
  "browser_trace",
  "browser_video",
  "browser_pdf",
  "browser_diagnostics",
] as const;

describe("advanced browser tools HTTP list", () => {
  it("publishes root and metadata security schemes for ChatGPT", async () => {
    const gateway = createGatewayApplication(
      makeGatewayConfig({
        browserWorker: {
          url: new URL("http://127.0.0.1:3350"),
          token: "x".repeat(32),
          timeoutMs: 1_000,
          maxPayloadBytes: 2 * 1024 * 1024,
        },
      }),
      {
        logger: silentLogger(),
        tokenVerifier: { verify: async () => validAuth },
      },
    );
    const http = await listen(gateway.app);

    try {
      const response = await fetch(new URL("/mcp", http.url), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      const body = await response.json() as {
        result: { tools: Array<Record<string, unknown>> };
      };
      const advanced = body.result.tools.filter((tool) =>
        (advancedToolNames as readonly string[]).includes(String(tool.name)),
      );

      expect(response.status).toBe(200);
      expect(advanced.map((tool) => tool.name)).toEqual(advancedToolNames);
      for (const tool of advanced) {
        expect(tool.inputSchema).toMatchObject({ type: "object" });
        expect(tool.outputSchema).toMatchObject({ type: "object" });
        expect(tool.securitySchemes).toEqual([
          { type: "oauth2", scopes: ["workspaces:read"] },
        ]);
        expect(tool._meta).toEqual({
          securitySchemes: [
            { type: "oauth2", scopes: ["workspaces:read"] },
          ],
        });
      }
    } finally {
      gateway.relay.close();
      await http.close();
    }
  });
});
