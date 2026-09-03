import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("edge connector CLI wiring", () => {
  it("passes the in-process executor as the source-control executor", () => {
    const sourcePath = fileURLToPath(new URL("../../../src/edge-connector-cli.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("sourceControlExecutor: workspaceExecutor");
  });
});
