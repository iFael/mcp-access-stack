import { describe, expect, test, jest } from "@jest/globals";
import {
  prepareWorkspaceTask,
  readWorkspaceFiles,
  validateWorkspaceChanges,
  type WorkspaceWorkflowExecutor,
} from "../../../src/actions/workspace-workflows.js";
import {
  prepareWorkspaceTaskInputSchema,
  readFilesActionInputSchema,
  validateWorkspaceChangesInputSchema,
} from "../../../src/actions/schemas.js";

function fileResult(path: string, content = "content") {
  return {
    path,
    content,
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    sha256: "a".repeat(64),
    encoding: "utf-8" as const,
    lineEnding: "lf" as const,
  };
}

describe("GPT Actions workspace workflows", () => {
  test("prepares a change task with applicable documents and operational warnings", async () => {
    const readFile = jest.fn(async ({ path }: { path: string }) => fileResult(path));
    const executor = {
      inspectGit: jest.fn(async () => ({
        workspaceId: "project",
        root: "services/api",
        branch: "main",
        diffMode: "summary",
        status: [{ path: "src/index.ts", indexStatus: " ", workTreeStatus: "M" }],
        staged: "",
        unstaged: "",
        truncated: false,
      })),
      getWorkspaceContext: jest.fn(async ({ root }: { root: string }) => ({
        workspaceId: "project",
        rootPath: root,
        instructionFiles: root === "." ? [{ path: "AGENTS.md", content: "root" }] : [],
        availableInstructionFiles: [
          "services/api/AGENTS.md",
          "services/other/AGENTS.md",
        ],
        skills: [],
        git: { isGitRepository: true, root: ".", branch: "main" },
      })),
      listFiles: jest.fn(async ({ glob }: { glob?: string }) => {
        if (glob === ".codex/*.md") {
          return { files: [".codex/HANDOFF.md"], truncated: false };
        }
        if (glob === "**/.codex/*.md") {
          return {
            files: [
              "services/api/.codex/API.md",
              "services/other/.codex/OTHER.md",
            ],
            truncated: false,
          };
        }
        return {
          files: [
            "services/api/config.jsonc",
            "services/api/src/config.jsonc",
            "services/other/config.jsonc",
          ],
          truncated: true,
        };
      }),
      readFile,
      runValidation: jest.fn(),
    } as unknown as WorkspaceWorkflowExecutor;

    const result = await prepareWorkspaceTask(
      executor,
      prepareWorkspaceTaskInputSchema.parse({
        workspaceId: "project",
        root: "services/api",
        targetPaths: ["src/index.ts"],
        intent: "change",
        includeDocumentContents: true,
      }),
    );

    expect(result.recommendedReads).toEqual(
      expect.arrayContaining([
        ".codex/HANDOFF.md",
        "AGENTS.md",
        "services/api/.codex/API.md",
        "services/api/AGENTS.md",
        "services/api/README.md",
        "services/api/.editorconfig",
        "services/api/src/config.jsonc",
      ]),
    );
    expect(result.recommendedReads).not.toContain("services/other/.codex/OTHER.md");
    expect(result.warnings).toEqual([
      "The selected repository is on main; do not modify this branch.",
      "The working tree already contains changes that must be preserved.",
      "Document discovery reached a workspace listing limit.",
    ]);
    expect(readFile).toHaveBeenCalled();
  });

  test("validates branch, path boundaries, diff-check and text metadata", async () => {
    const executor = {
      inspectGit: jest.fn(async () => ({
        workspaceId: "project",
        root: "services/api",
        branch: "feature/work",
        diffMode: "full",
        status: [
          { path: "src/index.ts", indexStatus: " ", workTreeStatus: "M" },
          { path: "secrets/token.txt", indexStatus: "?", workTreeStatus: "?" },
        ],
        staged: "staged",
        unstaged: "unstaged",
        truncated: true,
      })),
      runValidation: jest.fn(async () => ({
        workspaceId: "project",
        root: "services/api",
        validation: "diff-check",
        scope: "changes",
        executed: true,
        passed: false,
        tool: { name: "git", version: "git version test", available: true },
        filesScanned: 2,
        findings: [{ path: "src/index.ts", line: 2, message: "trailing whitespace" }],
        findingsCount: 1,
        truncated: false,
        durationMs: 1,
        issues: [],
        warnings: [],
      })),
      readFile: jest.fn(async ({ path }: { path: string }) => fileResult(path)),
      getWorkspaceContext: jest.fn(),
      listFiles: jest.fn(),
    } as unknown as WorkspaceWorkflowExecutor;

    const result = await validateWorkspaceChanges(
      executor,
      validateWorkspaceChangesInputSchema.parse({
        workspaceId: "project",
        root: "services/api",
        expectedBranch: "feature/expected",
        allowedPathPrefixes: ["src"],
        forbiddenPathPrefixes: ["secrets"],
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "Expected branch feature/expected, but found feature/work.",
        "Changes outside allowedPathPrefixes: secrets/token.txt",
        "Changes under forbiddenPathPrefixes: secrets/token.txt",
        "trailing whitespace",
      ]),
    );
    expect(result.warnings).toContain("The returned Git diff was truncated by maxDiffBytes.");
    expect(result.fileMetadata).toEqual([
      expect.objectContaining({ path: "services/api/src/index.ts" }),
      expect.objectContaining({ path: "services/api/secrets/token.txt" }),
    ]);
  });

  test("reads files in batches of three and enforces the aggregate byte limit", async () => {
    let active = 0;
    let maxActive = 0;
    const readFile = jest.fn(async ({ path }: { path: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return fileResult(path, "1234");
    });
    const executor = { readFile } as unknown as WorkspaceWorkflowExecutor;
    const input = readFilesActionInputSchema.parse({
      workspaceId: "project",
      files: ["a", "b", "c", "d"].map((path) => ({ path })),
      maxTotalBytes: 16,
    });

    await expect(readWorkspaceFiles(executor, input)).resolves.toMatchObject({
      workspaceId: "project",
      totalBytes: 16,
    });
    expect(maxActive).toBe(3);

    await expect(
      readWorkspaceFiles(executor, { ...input, maxTotalBytes: 15 }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});
