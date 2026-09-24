import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("edge connector CLI wiring", () => {
  it("routes source control through the active workspace executor and keeps the Windows companion optional", () => {
    const sourcePath = fileURLToPath(new URL("../../../src/edge-connector-cli.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("sourceControlExecutor: workspaceExecutor");
    expect(source).toContain("CompositeWorkspaceExecutor.create");
    expect(source).toContain("probeOnCreate: false");
    expect(source).toContain("MCP_WINDOWS_COMPANION_ENABLED");
    expect(source).toContain("assertLoopbackMcpCompatibility(localBaseUrl, internalAssertion)");
    expect(source.indexOf("assertLoopbackMcpCompatibility(localBaseUrl, internalAssertion)"))
      .toBeLessThan(source.indexOf("await connector.run(controller.signal)"));
  });
});
