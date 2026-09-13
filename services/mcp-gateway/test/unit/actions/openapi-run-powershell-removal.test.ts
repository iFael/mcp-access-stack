import { describe, expect, test } from "@jest/globals";
import type { GatewayActionsConfig, GatewayConfig } from "../../../src/config.js";
import { createGptActionsOpenApi } from "../../../src/actions/openapi.js";

describe("run_powershell GPT Actions removal", () => {
  test("does not publish the PowerShell compatibility endpoint", () => {
    const schema = createGptActionsOpenApi(
      {
        publicBaseUrl: new URL("https://example.test"),
        mcpPath: "/mcp",
      } as GatewayConfig,
      {
        tokenSha256: "0".repeat(64),
        allowShell: true,
        allowWrite: true,
        workspaceIds: ["project"],
      } as GatewayActionsConfig,
    ) as { paths: Record<string, unknown> };

    expect(schema.paths).not.toHaveProperty("/shell/powershell");
    expect(schema.paths).toHaveProperty("/shell/run");
  });
});
