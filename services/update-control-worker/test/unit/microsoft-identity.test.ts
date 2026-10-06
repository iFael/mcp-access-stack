import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@jest/globals";
import { fileURLToPath } from "node:url";

async function read(relative: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("retired external identity surface", () => {
  it("keeps Microsoft/Entra out of the active Update Control runtime", async () => {
    const active = [
      await read("../../src/worker.ts"),
      await read("../../src/auth-state.ts"),
      await read("../../src/update-control-identity-oauth.ts"),
      await read("../../../../tooling/update-control-deploy-preflight.mjs"),
      await read("../../../../.github/workflows/update-control-deploy.yml"),
    ].join("\n");

    expect(active).not.toContain("MICROSOFT_CLIENT_ID");
    expect(active).not.toContain("MICROSOFT_CLIENT_SECRET");
    expect(active).not.toContain("MICROSOFT_TENANT");
    expect(active).not.toContain("login.microsoftonline.com");
    expect(active).not.toContain("graph.microsoft.com");
  });
});
