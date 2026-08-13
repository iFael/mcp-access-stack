import { afterEach, describe, expect, test } from "@jest/globals";
import {
  runGitInBatches,
  runGitStrict,
} from "../../../src/git/process-runner.js";
import {
  createFixture,
  git,
  initializeGitRepository,
  type Fixture,
  writeWorkspaceFile,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("git process runner", () => {
  test("executes Git without a shell and returns stdout", async () => {
    fixture = await createFixture();
    initializeGitRepository(fixture.workspacePath);

    await expect(
      runGitStrict(
        fixture.workspacePath,
        ["rev-parse", "--is-inside-work-tree"],
        1_024,
      ),
    ).resolves.toBe("true\n");
  }, 15_000);

  test("enforces strict output limits", async () => {
    fixture = await createFixture();
    initializeGitRepository(fixture.workspacePath);

    await expect(
      runGitStrict(
        fixture.workspacePath,
        ["rev-parse", "--show-toplevel"],
        1,
      ),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  }, 15_000);

  test("truncates batched diff output and honors cancellation", async () => {
    fixture = await createFixture();
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "a.txt", "base a\n");
    await writeWorkspaceFile(fixture.workspacePath, "b.txt", "base b\n");
    git(fixture.workspacePath, ["add", "."]);
    git(fixture.workspacePath, ["commit", "-m", "baseline"]);
    await writeWorkspaceFile(fixture.workspacePath, "a.txt", "changed a with more content\n");
    await writeWorkspaceFile(fixture.workspacePath, "b.txt", "changed b with more content\n");

    const result = await runGitInBatches(
      fixture.workspacePath,
      ["diff", "--no-ext-diff", "--"],
      ["a.txt", "b.txt"],
      32,
    );
    expect(result.truncated).toBe(true);
    expect(result.remainingBytes).toBe(0);
    expect(result.output).toContain("...[diff truncated]");

    const controller = new AbortController();
    controller.abort();
    await expect(
      runGitStrict(
        fixture.workspacePath,
        ["status", "--short"],
        1_024,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  }, 30_000);
});
