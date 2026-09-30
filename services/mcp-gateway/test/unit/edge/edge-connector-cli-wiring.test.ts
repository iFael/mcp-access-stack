import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("edge connector CLI wiring", () => {
  it("reuses repository, workspace and Browser Worker components on the remote runtime", () => {
    const sourcePath = fileURLToPath(new URL("../../../src/edge-connector-cli.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("LocalRepositoryManager.create");
    expect(source).toContain("const sourceControlExecutor = reloadable.sourceControlExecutor");
    expect(source).toContain("companionRepositoryBinder: repositories");
    expect(source).toContain("ScopedBrowserWorkerPool.create");
    expect(source).toContain("browser: browserPool");
    expect(source).toContain("await browserPool?.close()");
    expect(source).toContain("assertLoopbackMcpCompatibility(localBaseUrl, internalAssertion)");
    expect(source.indexOf("assertLoopbackMcpCompatibility(localBaseUrl, internalAssertion)"))
      .toBeLessThan(source.indexOf("await connector.run(controller.signal)"));
  });
});
