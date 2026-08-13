import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import { afterEach, describe, expect, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import {
  createFixture,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("policy and permissions", () => {
  test("lists only enabled workspaces without exposing rootPath", async () => {
    fixture = await createFixture();
    const disabledRoot = path.join(fixture.basePath, "disabled");
    await mkdir(disabledRoot);
    await writePolicy(fixture.policyPath, [
      makeWorkspacePolicy(fixture.workspacePath),
      {
        ...makeWorkspacePolicy(disabledRoot, { enabled: false }),
        id: "disabled",
      },
    ]);

    const agent = await LocalAgent.create(fixture.policyPath);
    const workspaces = await agent.listWorkspaces();

    expect(workspaces).toEqual([
      {
        id: "test",
        name: "Test Workspace",
        workspaceKind: "repository",
        enabled: true,
        permissionProfile: "planning-readonly",
        writesEnabled: false,
        shellsEnabled: false,
        allowedShells: ["powershell"],
      },
    ]);
    expect(JSON.stringify(workspaces)).not.toContain(fixture.workspacePath);
  });

  test("rejects duplicate workspace ids", async () => {
    fixture = await createFixture();
    await writePolicy(fixture.policyPath, [
      makeWorkspacePolicy(fixture.workspacePath),
      makeWorkspacePolicy(fixture.workspacePath),
    ]);

    await expect(LocalAgent.create(fixture.policyPath)).rejects.toMatchObject({
      code: "POLICY_INVALID",
    });
  });

  test("rejects invalid full-repo-readonly configuration", async () => {
    fixture = await createFixture();
    await mkdir(path.join(fixture.workspacePath, "src"));
    await writePolicy(fixture.policyPath, [
      makeWorkspacePolicy(fixture.workspacePath, {
        profile: "full-repo-readonly",
        allowedRoots: ["src"],
      }),
    ]);

    await expect(LocalAgent.create(fixture.policyPath)).rejects.toMatchObject({
      code: "POLICY_INVALID",
    });
  });

  test("enforces builder-review without removing direct read access", async () => {
    fixture = await createFixture({ profile: "builder-review" });
    await writeWorkspaceFile(fixture.workspacePath, "file.txt", "allowed");
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.listFiles({ workspaceId: "test" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      agent.searchFiles({ workspaceId: "test", query: "allowed" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      agent.readFile({ workspaceId: "test", path: "file.txt" }),
    ).resolves.toMatchObject({ content: "allowed" });
  });

  test("rejects disabled and missing workspaces", async () => {
    fixture = await createFixture({ enabled: false });
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({ workspaceId: "test", path: "file.txt" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_DISABLED" });
    await expect(
      agent.readFile({ workspaceId: "missing", path: "file.txt" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  test("gets workspace context from an authorized subdirectory", async () => {
    fixture = await createFixture();
    await mkdir(path.join(fixture.workspacePath, "area"));
    await writeWorkspaceFile(fixture.workspacePath, "area/AGENTS.md", "# area");
    await writeWorkspaceFile(fixture.workspacePath, "area/nested/CLAUDE.md", "# nested");
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.getWorkspaceContext({ workspaceId: "test", root: "area" }),
    ).resolves.toMatchObject({
      workspaceId: "test",
      rootPath: "area",
      instructionFiles: [{ name: "AGENTS.md", path: "area/AGENTS.md", exists: true }],
      availableInstructionFiles: ["area/nested/CLAUDE.md"],
    });
  });
});

describe("audit", () => {
  test("records allowed and denied calls without file or query content", async () => {
    fixture = await createFixture({ allowedRoots: ["src"] });
    await writeWorkspaceFile(
      fixture.workspacePath,
      "src/private.txt",
      "needle-secret-value",
    );
    const agent = await LocalAgent.create(fixture.policyPath);

    await agent.searchFiles({ workspaceId: "test", query: "needle-secret-value" });
    await expect(
      agent.readFile({ workspaceId: "test", path: "outside.txt" }),
    ).rejects.toBeInstanceOf(AppError);

    const audit = await readFile(path.join(fixture.auditPath, "audit.ndjson"), "utf8");
    const entries = audit.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      operation: "searchFiles",
      workspaceId: "test",
      status: "allowed",
      queryLength: 19,
    });
    expect(entries[0].queryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(entries[1]).toMatchObject({
      operation: "readFile",
      status: "denied",
      reason: "PATH_OUTSIDE_ALLOWED_ROOTS",
    });
    expect(audit).not.toContain("needle-secret-value");
  });

  test("fails closed when the audit directory is unavailable", async () => {
    fixture = await createFixture();
    const unavailablePath = path.join(fixture.basePath, "not-a-directory");
    await writeFile(unavailablePath, "file", "utf8");
    process.env.VS_CODE_GPT_DATA_DIR = unavailablePath;

    await expect(LocalAgent.create(fixture.policyPath)).rejects.toMatchObject({
      code: "AUDIT_FAILED",
    });
  });

  test("audits invalid API inputs", async () => {
    fixture = await createFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({
        workspaceId: "test",
        path: "file.txt",
        startLine: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const audit = await readFile(path.join(fixture.auditPath, "audit.ndjson"), "utf8");
    expect(JSON.parse(audit.trim())).toMatchObject({
      operation: "readFile",
      workspaceId: "test",
      status: "error",
      reason: "INVALID_ARGUMENT",
    });
  });
});
