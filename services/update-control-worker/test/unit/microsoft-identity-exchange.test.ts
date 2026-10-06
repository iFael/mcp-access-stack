import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@jest/globals";
import { fileURLToPath } from "node:url";

describe("retired Microsoft exchange module", () => {
  it("contains no upstream identity exchange implementation", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../../src/microsoft-identity.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("local TOTP only");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("MICROSOFT_");
    expect(source).not.toContain("login.microsoftonline.com");
    expect(source).not.toContain("graph.microsoft.com");
  });
});
