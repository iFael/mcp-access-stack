import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { runDiffCheckValidation } from "../../../src/validation/diff-check.js";
import {
  createFixture,
  git,
  initializeGitRepository,
  type Fixture,
  writeWorkspaceFile,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

jest.setTimeout(60_000);

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("runDiffCheckValidation", () => {
  test("reports staged and unstaged whitespace findings", async () => {
    fixture = await createFixture();
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "staged.txt", "clean\n");
    await writeWorkspaceFile(fixture.workspacePath, "unstaged.txt", "clean\n");
    git(fixture.workspacePath, ["add", "staged.txt", "unstaged.txt"]);
    git(fixture.workspacePath, ["commit", "-m", "initial"]);

    await writeWorkspaceFile(
      fixture.workspacePath,
      "staged.txt",
      "staged whitespace   \n",
    );
    git(fixture.workspacePath, ["add", "staged.txt"]);
    await writeWorkspaceFile(
      fixture.workspacePath,
      "unstaged.txt",
      "unstaged whitespace   \n",
    );

    const result = await runDiffCheckValidation({
      context: {
        repositoryRoot: fixture.workspacePath,
        rootPrefix: ".",
      },
      scope: "paths",
      targets: [
        { relativePath: "staged.txt" },
        { relativePath: "unstaged.txt" },
      ],
      maxFindings: 20,
      timeoutMs: 120_000,
      signal: undefined,
    });

    expect(result.passed).toBe(false);
    expect(result.filesScanned).toBe(2);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "git-diff-check-staged",
          path: "staged.txt",
        }),
        expect.objectContaining({
          ruleId: "git-diff-check-unstaged",
          path: "unstaged.txt",
        }),
      ]),
    );
  });

  test("limits returned findings without changing the total count", async () => {
    fixture = await createFixture();
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "first.txt", "clean\n");
    await writeWorkspaceFile(fixture.workspacePath, "second.txt", "clean\n");
    git(fixture.workspacePath, ["add", "first.txt", "second.txt"]);
    git(fixture.workspacePath, ["commit", "-m", "initial"]);
    await writeWorkspaceFile(fixture.workspacePath, "first.txt", "first   \n");
    await writeWorkspaceFile(fixture.workspacePath, "second.txt", "second   \n");

    const result = await runDiffCheckValidation({
      context: {
        repositoryRoot: fixture.workspacePath,
        rootPrefix: ".",
      },
      scope: "paths",
      targets: [
        { relativePath: "first.txt" },
        { relativePath: "second.txt" },
      ],
      maxFindings: 1,
      timeoutMs: 120_000,
      signal: undefined,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findingsCount).toBeGreaterThan(1);
    expect(result.truncated).toBe(true);
  });
});
