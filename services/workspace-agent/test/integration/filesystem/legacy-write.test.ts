import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import { createFixture, type Fixture } from "../../support/helpers.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("LegacySite development writes", () => {
  test("allows creating and updating files anywhere in the workspace", async () => {
    fixture = await createFixture({ profile: "full-repo-write", allowedRoots: ["."] });
    const policyPath = fixture.policyPath;
    const localPolicy = JSON.parse(await readFile(policyPath, "utf8")) as {
      workspaces: Array<Record<string, unknown>>;
    };
    localPolicy.workspaces[0] = {
      ...localPolicy.workspaces[0],
      id: "legacySite",
      permissionProfile: "full-repo-write",
      allowWrites: ["."],
    };
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(policyPath, JSON.stringify(localPolicy, null, 2), "utf8"),
    );

    const agent = await LocalAgent.create(policyPath);
    const nestedTarget = "XPNet/ScriptsAd/Relatorios/Gnre/.codex/CURRENT_TASK.md";
    const rootTarget = "README.md";

    await expect(
      agent.writeFile({
        workspaceId: "legacySite",
        path: nestedTarget,
        content: "# nested write test\n",
      }),
    ).resolves.toMatchObject({ path: nestedTarget, created: true });

    await expect(
      agent.writeFile({
        workspaceId: "legacySite",
        path: rootTarget,
        content: "# root write test\n",
      }),
    ).resolves.toMatchObject({ path: rootTarget, created: true });
  });
});
