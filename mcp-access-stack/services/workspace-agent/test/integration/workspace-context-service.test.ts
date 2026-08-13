import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import { WorkspaceRegistry } from "../../src/workspace-registry.js";
import { buildWorkspaceContext } from "../../src/workspace-context-service.js";
import {
  createFixture,
  type Fixture,
  writeWorkspaceFile,
} from "../support/helpers.js";

let fixture: Fixture | undefined;

jest.setTimeout(15_000);

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("workspace context service", () => {
  test("skips operational artifact directories during nested instruction discovery", async () => {
    fixture = await createFixture();
    await writeWorkspaceFile(fixture.workspacePath, "AGENTS.md", "root instructions\n");
    await writeWorkspaceFile(fixture.workspacePath, "src/AGENTS.md", "source instructions\n");
    await writeWorkspaceFile(fixture.workspacePath, "runtime/AGENTS.md", "runtime instructions\n");
    await writeWorkspaceFile(fixture.workspacePath, "releases/r1/CLAUDE.md", "release instructions\n");
    await writeWorkspaceFile(
      fixture.workspacePath,
      ".runtime-tools/tool/AGENTS.md",
      "tool instructions\n",
    );

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const result = await buildWorkspaceContext(workspace);

    expect(result.instructionFiles.map((entry) => entry.path)).toContain("AGENTS.md");
    expect(result.availableInstructionFiles).toContain("src/AGENTS.md");
    expect(result.availableInstructionFiles.some((entry) => entry.startsWith("runtime/"))).toBe(false);
    expect(result.availableInstructionFiles.some((entry) => entry.startsWith("releases/"))).toBe(false);
    expect(result.availableInstructionFiles.some((entry) => entry.startsWith(".runtime-tools/"))).toBe(false);
  });

  test("honors cancellation before context discovery", async () => {
    fixture = await createFixture();
    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const controller = new AbortController();
    controller.abort(new AppError("AGENT_TIMEOUT", "deadline reached"));

    await expect(
      buildWorkspaceContext(workspace, ".", controller.signal),
    ).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });
  });
});
