import { describe, expect, it, jest } from "@jest/globals";
import { MCP_FULL_TOOL_CATALOG_NAMES } from "@vs-code-gpt/shared";
import { createGatewayApplication } from "../../../src/app.js";
import type { GatewayConfig } from "../../../src/config.js";
import {
  edgeHeaders,
  listen,
  makeEdgeGatewayDependencies,
  makeGatewayConfig,
} from "../../support/helpers.js";

jest.setTimeout(15_000);

describe("embedded gateway HTTP surface", () => {
  it("rejects an untrusted Origin", async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await fetch(new URL("/health/live", fixture.url), {
        headers: { origin: "https://evil.example" },
      });
      expect(response.status).toBe(403);
    } finally {
      await fixture.close();
    }
  });

  it("rejects MCP requests without the connector-owned Edge assertion", async () => {
    const fixture = await createHttpFixture();
    try {
      const missing = await postMcp(
        fixture.url,
        toolsListRequest(),
        {},
      );
      expect(missing.status).toBe(401);
      await expect(missing.json()).resolves.toEqual({
        error: "edge_trust_invalid",
      });

      const wrong = await postMcp(
        fixture.url,
        toolsListRequest(),
        {
          ...edgeHeaders(),
          "x-mcp-edge-internal-assertion": "b".repeat(43),
        },
      );
      expect(wrong.status).toBe(401);
      await expect(wrong.json()).resolves.toEqual({
        error: "edge_trust_invalid",
      });
    } finally {
      await fixture.close();
    }
  });

  it("publishes the complete internal MCP catalog through edge-trusted auth", async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await postMcp(
        fixture.url,
        toolsListRequest(),
        edgeHeaders(),
      );
      const body = await response.json() as {
        result: { tools: Array<Record<string, unknown>> };
      };

      expect(response.status).toBe(200);
      expect(body.result.tools.map((tool) => tool.name).sort()).toEqual(
        [...MCP_FULL_TOOL_CATALOG_NAMES].sort(),
      );

      for (const tool of body.result.tools) {
        expect(typeof tool.inputSchema).toBe("object");
        if (tool.name === "browser_screenshot") {
          expect(tool.outputSchema).toBeUndefined();
        } else {
          expect(typeof tool.outputSchema).toBe("object");
        }
        expect(tool.securitySchemes).toEqual([{ type: "noauth" }]);
        expect(tool._meta).toEqual({
          securitySchemes: [{ type: "noauth" }],
        });
      }

      expect(
        body.result.tools.find((tool) => tool.name === "write_file")?.annotations,
      ).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      });
      expect(
        body.result.tools.find((tool) => tool.name === "inspect_workspace_batch")
          ?.annotations,
      ).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      });
    } finally {
      await fixture.close();
    }
  });

  it("limits repeated MCP requests per ip", async () => {
    const fixture = await createHttpFixture({
      rateLimit: { windowMs: 60_000, max: 2 },
    });
    try {
      await postMcp(fixture.url, toolsListRequest(), edgeHeaders());
      await postMcp(fixture.url, toolsListRequest(), edgeHeaders());
      const limited = await postMcp(
        fixture.url,
        toolsListRequest(),
        edgeHeaders(),
      );

      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toEqual({
        error: "rate_limit_exceeded",
      });
    } finally {
      await fixture.close();
    }
  });

  it("serves only the configured internal MCP path", async () => {
    const fixture = await createHttpFixture({ mcpPath: "/mcp-a8f3k2x9" });
    try {
      const configured = await postMcp(
        fixture.url,
        toolsListRequest(),
        edgeHeaders(),
        "/mcp-a8f3k2x9",
      );
      expect(configured.status).toBe(200);

      const defaultPath = await postMcp(
        fixture.url,
        toolsListRequest(),
        edgeHeaders(),
      );
      expect(defaultPath.status).toBe(404);
    } finally {
      await fixture.close();
    }
  });
});

async function createHttpFixture(
  overrides: Partial<GatewayConfig> = {},
) {
  const gateway = createGatewayApplication(
    makeGatewayConfig(overrides),
    makeEdgeGatewayDependencies(),
  );
  const http = await listen(gateway.app);
  return {
    ...http,
    close: async () => {
      await gateway.close();
      await http.close();
    },
  };
}

function toolsListRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };
}

function postMcp(
  url: URL,
  body: unknown,
  headers: Record<string, string>,
  path = "/mcp",
): Promise<Response> {
  return fetch(new URL(path, url), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
