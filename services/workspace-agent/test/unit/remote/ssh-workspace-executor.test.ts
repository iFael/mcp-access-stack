import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SshWorkspaceExecutor } from "../../../src/remote/ssh-workspace-executor.js";
import type {
  RemoteBytesResult,
  RemoteDirectoryListing,
  RemoteGitHubApiRequest,
  RemoteGitHubApiResult,
  RemoteProcessResult,
  RemoteWriteResult,
  SshWindowsTransport,
} from "../../../src/remote/ssh-windows-transport.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

function remoteResult(
  stdout = "",
  exitCode: number | null = 0,
): RemoteProcessResult {
  return { exitCode, stdout, stderr: "", timedOut: false };
}

function githubResponse(
  value: unknown,
  statusCode = 200,
): RemoteGitHubApiResult {
  return {
    statusCode,
    body: statusCode >= 200 && statusCode < 300 ? JSON.stringify(value) : "",
    authenticationFailed: false,
  };
}

function githubRepositoryRecord(
  owner = "octo",
  name = "repo",
  visibility: "private" | "public" | "internal" = "private",
) {
  return {
    owner: { login: owner },
    name,
    full_name: `${owner}/${name}`,
    default_branch: "main",
    visibility,
    html_url: `https://github.com/${owner}/${name}`,
  };
}

function githubPullRequestRecord(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: "open",
    title: "Typed SSH PR",
    html_url: "https://github.com/octo/repo/pull/7",
    head: { sha: SHA_C },
    base: { sha: SHA_A },
    merged: false,
    merge_commit_sha: null,
    ...overrides,
  };
}

function queueRepository(
  transport: FakeTransport,
  topLevel = "C:/workspace",
): void {
  transport.execResults.push(
    remoteResult("true\n"),
    remoteResult(`${topLevel}\n`),
  );
}

class FakeTransport {
  readonly files = new Map<string, Buffer>([
    ["README.md", Buffer.from("line one\nline two\n", "utf8")],
  ]);
  commands: Array<{ shell: string; command: string; cwd: string }> = [];
  execCommands: Array<{ executable: string; argv: string[]; cwd: string }> = [];
  execResults: RemoteProcessResult[] = [];
  githubApiCalls: Array<{ rootPath: string; request: RemoteGitHubApiRequest }> = [];
  githubApiResults: Array<RemoteGitHubApiResult | Error> = [];
  probeCalls = 0;

  async probeRoot() {
    this.probeCalls += 1;
    return { fullPath: "C:\\workspace", kind: "directory" as const };
  }

  async list(): Promise<RemoteDirectoryListing> {
    return {
      entries: [...this.files.entries()].map(([filePath, value]) => ({
        path: filePath,
        kind: "file" as const,
        sizeBytes: value.byteLength,
      })),
      truncated: false,
    };
  }

  async readBytes(_root: string, logicalPath: string): Promise<RemoteBytesResult> {
    const value = this.files.get(logicalPath);
    if (!value) throw new Error("missing fake file");
    return {
      contentBase64: value.toString("base64"),
      sizeBytes: value.byteLength,
      sha256: sha256(value),
    };
  }

  async writeBytes(
    _root: string,
    logicalPath: string,
    value: Buffer,
    options: { expectedSha256?: string },
  ): Promise<RemoteWriteResult> {
    const before = this.files.get(logicalPath);
    if (before && options.expectedSha256 && sha256(before) !== options.expectedSha256) {
      throw new Error("hash mismatch");
    }
    this.files.set(logicalPath, Buffer.from(value));
    return { created: !before, sizeBytes: value.byteLength, sha256: sha256(value) };
  }

  async runShell(
    _root: string,
    cwd: string,
    shell: string,
    command: string,
  ): Promise<RemoteProcessResult> {
    this.commands.push({ shell, command, cwd });
    return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
  }

  async githubApi(
    rootPath: string,
    request: RemoteGitHubApiRequest,
  ): Promise<RemoteGitHubApiResult> {
    this.githubApiCalls.push({ rootPath, request });
    const next = this.githubApiResults.shift();
    if (next instanceof Error) throw next;
    return next ?? githubResponse({});
  }

  async exec(_root: string, cwd: string, executable: string, argv: string[]): Promise<RemoteProcessResult> {
    this.execCommands.push({ executable, argv, cwd });
    return this.execResults.shift() ?? remoteResult("main\n");
  }
}

describe("SshWorkspaceExecutor", () => {
  let stateDirectory: string;
  let transport: FakeTransport;
  let executor: SshWorkspaceExecutor;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-ssh-executor-"));
    transport = new FakeTransport();
    executor = await SshWorkspaceExecutor.create({
      policy: {
        version: 1,
        workspaces: [
          {
            id: "test",
            name: "Test",
            rootPath: "C:\\workspace",
            workspaceKind: "repository",
            enabled: true,
            permissionProfile: "full-repo-write",
            confirmationMode: "standard",
            allowedRoots: ["."],
            blockedGlobs: ["private/**"],
            limits: {
              maxFileBytes: 64_000,
              maxSearchResults: 100,
              maxSearchSnippetBytes: 20_000,
              maxDiffBytes: 500_000,
              maxListedFiles: 500,
            },
            allowWrites: ["."],
            allowShell: ["."],
            allowedShells: ["powershell", "pwsh"],
            sourceControl: {
              capabilities: [
                "github.repository.read",
                "github.repository.create",
                "github.pull_request.read",
                "github.pull_request.create",
                "github.pull_request.merge",
              ],
              accountOwners: ["octo", "octo-org"],
              additionalRepositories: ["octo/repo"],
            },
          },
        ],
      },
      backgroundStateDirectory: stateDirectory,
      transport: transport as unknown as SshWindowsTransport,
    });
  });

  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it("can skip the startup SSH probe for an optional companion workspace", async () => {
    const optionalTransport = new FakeTransport();
    const optionalExecutor = await SshWorkspaceExecutor.create({
      policy: {
        version: 1,
        workspaces: [
          {
            id: "optional-windows",
            name: "Optional Windows",
            rootPath: "C:\\workspace",
            workspaceKind: "repository",
            enabled: true,
            permissionProfile: "full-repo-write",
            confirmationMode: "standard",
            allowedRoots: ["."],
            blockedGlobs: [],
            limits: {
              maxFileBytes: 64_000,
              maxSearchResults: 100,
              maxSearchSnippetBytes: 20_000,
              maxDiffBytes: 500_000,
              maxListedFiles: 500,
            },
            allowWrites: ["."],
            allowShell: ["."],
            allowedShells: ["pwsh"],
          },
        ],
      },
      backgroundStateDirectory: stateDirectory,
      transport: optionalTransport as unknown as SshWindowsTransport,
      probeOnCreate: false,
    });

    expect(optionalTransport.probeCalls).toBe(0);
    await expect(optionalExecutor.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({ id: "optional-windows", shellsEnabled: true }),
    ]);
  });

  it("reads and writes through the SSH transport without changing MCP contracts", async () => {
    const read = await executor.readFile({ workspaceId: "test", path: "README.md" });
    expect(read).toMatchObject({
      path: "README.md",
      content: "line one\nline two\n",
      encoding: "utf-8",
    });

    const written = await executor.writeFile({
      workspaceId: "test",
      path: "src/new.txt",
      content: "remote\n",
    });
    expect(written).toMatchObject({ path: "src/new.txt", created: true });
    expect(transport.files.get("src/new.txt")?.toString("utf8")).toBe("remote\n");
  });

  it("keeps blocked paths server-side", async () => {
    await expect(
      executor.readFile({ workspaceId: "test", path: "private/secret.txt" }),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });
  });

  it("requires confirmation before dispatching a destructive remote shell command", async () => {
    const first = await executor.runCommand({
      workspaceId: "test",
      shell: "powershell",
      command: "Remove-Item -LiteralPath .\\obsolete.txt",
      timeoutMs: 30_000,
    });
    expect(first.status).toBe("confirmation_required");
    expect(transport.commands).toHaveLength(0);
    if (first.status !== "confirmation_required") throw new Error("expected confirmation");

    const second = await executor.runCommand({
      workspaceId: "test",
      shell: "powershell",
      command: "Remove-Item -LiteralPath .\\obsolete.txt",
      timeoutMs: 30_000,
      confirmationId: first.confirmationId,
    });
    expect(second.status).toBe("executed");
    expect(transport.commands).toHaveLength(1);
  });

  it("requires explicit confirmation before remote UAC elevation", async () => {
    const pending = await executor.runCommand({
      workspaceId: "test",
      shell: "powershell",
      command: "Start-Process powershell -Verb RunAs",
      timeoutMs: 30_000,
    });

    expect(pending).toMatchObject({
      status: "confirmation_required",
      reasons: expect.arrayContaining([
        "elevation or UAC operation requires explicit confirmation",
      ]),
    });
    expect(transport.commands).toHaveLength(0);
  });

  it("routes main push to confirmation without probing the current branch", async () => {
    const result = await executor.runCommand({
      workspaceId: "test",
      shell: "powershell",
      command: "git push origin main",
      timeoutMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "confirmation_required",
      reasons: expect.arrayContaining(["git push requires explicit user confirmation"]),
    });
    expect(transport.execCommands).toHaveLength(0);
    expect(transport.commands).toHaveLength(0);
  });

  it("fails closed for interactive background tasks and persistent stdin over SSH", async () => {
    await expect(
      executor.startBackgroundTask({
        workspaceId: "test",
        operation: "remote-interactive",
        shell: "powershell",
        command: "Write-Output 'never-runs'",
        timeoutMs: 30_000,
        interactive: true,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(transport.commands).toHaveLength(0);

    await expect(
      executor.writeBackgroundTaskStdin({
        workspaceId: "test",
        id: "123e4567-e89b-42d3-a456-426614174099",
        input: "hello\n",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("uses the same confirmation flow for risky remote background tasks", async () => {
    const input = {
      workspaceId: "test",
      operation: "remote-cleanup",
      shell: "powershell" as const,
      command: "Remove-Item -LiteralPath .\\obsolete.txt -Force",
      timeoutMs: 30_000,
    };

    const pending = await executor.startBackgroundTask(input);
    expect(pending).toMatchObject({
      status: "confirmation_required",
      reasons: expect.arrayContaining(["delete, remove or force-clean operation"]),
    });
    expect(transport.commands).toHaveLength(0);
    if (pending.status !== "confirmation_required") throw new Error("expected confirmation");

    const started = await executor.startBackgroundTask({
      ...input,
      confirmationId: pending.confirmationId,
    });
    expect(started).toMatchObject({
      status: "background_task_started",
      task: { operation: input.operation },
    });
    if (started.status !== "background_task_started") throw new Error("expected background task");
    expect(JSON.stringify(started.task)).not.toContain("confirmationId");
    expect(JSON.stringify(started.task)).not.toContain(pending.confirmationId);

    await expect(
      executor.startBackgroundTask({
        ...input,
        confirmationId: pending.confirmationId,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFIRMATION_INVALID" });

    await executor.waitBackgroundTask({
      workspaceId: "test",
      id: started.task.id,
      timeoutMs: 5_000,
      maxBytes: 10_000,
    });
  });
  it("isolates remote background task lookup and listing by owner scope", async () => {
    const ownerA = { ownerScope: "openai-session:ssh-owner-a" };
    const ownerB = { ownerScope: "openai-session:ssh-owner-b" };
    const started = await executor.startBackgroundTask(
      {
        workspaceId: "test",
        operation: "remote-owner-check",
        shell: "powershell",
        command: "Write-Output 'owned'",
        timeoutMs: 30_000,
      },
      ownerA,
    );
    if (started.status !== "background_task_started") {
      throw new Error("expected background task");
    }

    expect(
      (
        await executor.getBackgroundTask(
          { workspaceId: "test", id: started.task.id },
          ownerA,
        )
      ).task?.id,
    ).toBe(started.task.id);
    expect(
      (
        await executor.getBackgroundTask(
          { workspaceId: "test", id: started.task.id },
          ownerB,
        )
      ).task,
    ).toBeNull();
    expect(
      (await executor.listBackgroundTasks({ workspaceId: "test" }, ownerA))
        .tasks.map((task) => task.id),
    ).toContain(started.task.id);
    expect(
      (await executor.listBackgroundTasks({ workspaceId: "test" }, ownerB))
        .tasks.map((task) => task.id),
    ).not.toContain(started.task.id);

    await executor.cancelBackgroundTask(
      { workspaceId: "test", id: started.task.id },
      ownerA,
    );
  });

  it("requires the selected remote root to be the Git top-level", async () => {
    queueRepository(transport, "C:/parent");

    await expect(
      executor.stagePaths({
        workspaceId: "test",
        paths: ["README.md"],
      }),
    ).rejects.toMatchObject({ code: "NOT_GIT_REPOSITORY" });

    expect(transport.execCommands.map((entry) => entry.argv)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["rev-parse", "--show-toplevel"],
    ]);
  });

  it("creates a typed feature branch remotely with exact HEAD preconditions", async () => {
    queueRepository(transport);
    transport.execResults.push(
      remoteResult(`${SHA_A}\n`),
      remoteResult("", 128),
      remoteResult(),
      remoteResult(`${SHA_A}\n`),
    );

    const result = await executor.createBranch({
      workspaceId: "test",
      branch: "feature/ssh",
      expectedHeadSha: SHA_A,
    });

    expect(result).toEqual({
      root: ".",
      branch: "feature/ssh",
      headSha: SHA_A,
    });
    const mutation = transport.execCommands.at(-2);
    expect(mutation?.executable).toBe("git");
    expect(mutation?.argv.slice(-4)).toEqual([
      "switch",
      "-c",
      "feature/ssh",
      SHA_A,
    ]);
    expect(mutation?.argv).toEqual(expect.arrayContaining([
      "-c",
      "commit.gpgSign=false",
      "merge.gpgSign=false",
    ]));
  });

  it("stages and unstages only explicit authorized remote paths", async () => {
    queueRepository(transport);
    transport.execResults.push(
      remoteResult(`${SHA_A}\n`),
      remoteResult(),
      remoteResult(),
      remoteResult(`${SHA_A}\n`),
      remoteResult(`${SHA_B}\n`),
    );
    const staged = await executor.stagePaths({
      workspaceId: "test",
      paths: ["src/a.ts"],
      expectedHeadSha: SHA_A,
      requireCleanIndex: true,
    });
    expect(staged).toEqual({
      root: ".",
      headSha: SHA_A,
      indexTreeSha: SHA_B,
      paths: ["src/a.ts"],
    });
    expect(transport.execCommands.at(-3)?.argv.slice(-3)).toEqual([
      "add",
      "--",
      "src/a.ts",
    ]);

    transport.execCommands.length = 0;
    queueRepository(transport);
    transport.execResults.push(
      remoteResult(`${SHA_A}\n`),
      remoteResult(`${SHA_B}\n`),
      remoteResult(),
      remoteResult(`${SHA_A}\n`),
      remoteResult(`${SHA_C}\n`),
    );
    const unstaged = await executor.unstagePaths({
      workspaceId: "test",
      paths: ["src/a.ts"],
      expectedHeadSha: SHA_A,
      expectedIndexTreeSha: SHA_B,
    });
    expect(unstaged).toEqual({
      root: ".",
      headSha: SHA_A,
      indexTreeSha: SHA_C,
      paths: ["src/a.ts"],
    });
    expect(transport.execCommands.at(-3)?.argv.slice(-4)).toEqual([
      "restore",
      "--staged",
      "--",
      "src/a.ts",
    ]);
  });

  it("blocks explicit remote staging when the index is already dirty", async () => {
    queueRepository(transport);
    transport.execResults.push(
      remoteResult(`${SHA_A}\n`),
      remoteResult("", 1),
    );

    await expect(
      executor.stagePaths({
        workspaceId: "test",
        paths: ["src/a.ts"],
        expectedHeadSha: SHA_A,
        requireCleanIndex: true,
      }),
    ).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });

    expect(
      transport.execCommands.some((entry) => entry.argv.includes("add")),
    ).toBe(false);
  });

  it("blocks remote staging paths denied by workspace policy", async () => {
    queueRepository(transport);

    await expect(
      executor.stagePaths({
        workspaceId: "test",
        paths: ["private/secret.txt"],
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });

    expect(transport.execCommands).toHaveLength(2);
  });

  it("commits remotely only after exact branch, HEAD and index checks", async () => {
    queueRepository(transport);
    transport.execResults.push(
      remoteResult("feature/ssh\n"),
      remoteResult(`${SHA_A}\n`),
      remoteResult(`${SHA_B}\n`),
      remoteResult(),
      remoteResult(`${SHA_C}\n`),
    );

    const result = await executor.commit({
      workspaceId: "test",
      message: "feat: remote typed git",
      expectedHeadSha: SHA_A,
      expectedIndexTreeSha: SHA_B,
    });

    expect(result).toEqual({
      root: ".",
      branch: "feature/ssh",
      commitSha: SHA_C,
    });
    expect(transport.execCommands.at(-2)?.argv.slice(-3)).toEqual([
      "commit",
      "-m",
      "feat: remote typed git",
    ]);

    transport.execCommands.length = 0;
    queueRepository(transport);
    transport.execResults.push(remoteResult("main\n"));
    await expect(
      executor.commit({
        workspaceId: "test",
        message: "blocked",
        expectedHeadSha: SHA_A,
        expectedIndexTreeSha: SHA_B,
      }),
    ).rejects.toMatchObject({ code: "GIT_PROTECTED_BRANCH" });
    expect(transport.execCommands).toHaveLength(3);
  });

  it("fast-forwards a remote branch only after clean exact preconditions", async () => {
    queueRepository(transport);
    transport.execResults.push(
      remoteResult("dev\n"),
      remoteResult(`${SHA_A}\n`),
      remoteResult(`${SHA_B}\n`),
      remoteResult("", 0),
      remoteResult("", 0),
      remoteResult("", 0),
      remoteResult(),
      remoteResult(`${SHA_B}\n`),
    );

    const result = await executor.mergeBranch({
      workspaceId: "test",
      sourceBranch: "feature/source",
      expectedTargetHeadSha: SHA_A,
      expectedSourceHeadSha: SHA_B,
    });

    expect(result).toEqual({
      root: ".",
      branch: "dev",
      previousHeadSha: SHA_A,
      headSha: SHA_B,
      sourceHeadSha: SHA_B,
      fastForwarded: true,
    });
    expect(transport.execCommands.at(-2)?.argv.slice(-3)).toEqual([
      "merge",
      "--ff-only",
      SHA_B,
    ]);
  });

  it("synchronizes an existing remote workspace branch by exact verified fast-forward", async () => {
    queueRepository(transport);
    transport.execResults.push(
      remoteResult(""),
      remoteResult("feature/work\n"),
      remoteResult(`${SHA_A}\n`),
      remoteResult(`${SHA_A}\n`),
      remoteResult(),
      remoteResult(`${SHA_B}\n`),
      remoteResult(`${SHA_B}\trefs/heads/main\n`),
      remoteResult(`${SHA_A}\n`),
      remoteResult(""),
      remoteResult("", 0),
      remoteResult(),
      remoteResult("main\n"),
      remoteResult(`${SHA_A}\n`),
      remoteResult(),
      remoteResult("main\n"),
      remoteResult(`${SHA_B}\n`),
      remoteResult(""),
    );

    const result = await executor.syncBranch({
      workspaceId: "test",
      branch: "main",
      remote: "origin",
      expectedRemoteSha: SHA_B,
    });

    expect(result).toEqual({
      root: ".",
      remote: "origin",
      branch: "main",
      previousBranch: "feature/work",
      previousHeadSha: SHA_A,
      previousTargetHeadSha: SHA_A,
      remoteSha: SHA_B,
      headSha: SHA_B,
      switched: true,
      fastForwarded: true,
      alreadyUpToDate: false,
    });
    expect(
      transport.execCommands.some(
        (entry) =>
          entry.argv[0] === "fetch" &&
          entry.argv.includes("origin") &&
          entry.argv.includes("refs/heads/main"),
      ),
    ).toBe(true);
    expect(
      transport.execCommands.some(
        (entry) =>
          entry.argv.includes("switch") && entry.argv.at(-1) === "main",
      ),
    ).toBe(true);
    expect(
      transport.execCommands.some(
        (entry) =>
          entry.argv.includes("merge") &&
          entry.argv.includes("--ff-only") &&
          entry.argv.at(-1) === SHA_B,
      ),
    ).toBe(true);
    expect(
      transport.execCommands.filter((entry) => entry.argv.includes("status")),
    ).toHaveLength(3);
  });

  it("reconciles an ambiguous remote push before reporting completion", async () => {
    queueRepository(transport);
    transport.execResults.push(
      remoteResult(`${SHA_C}\n`),
      remoteResult(`${SHA_A}\trefs/heads/feature/ssh\n`),
      remoteResult("", 1),
      remoteResult(`${SHA_C}\trefs/heads/feature/ssh\n`),
    );

    const result = await executor.pushBranch({
      workspaceId: "test",
      branch: "feature/ssh",
      expectedLocalSha: SHA_C,
      remote: "origin",
      expectedRemoteSha: SHA_A,
    });

    expect(result).toEqual({
      status: "completed",
      root: ".",
      remote: "origin",
      branch: "feature/ssh",
      localSha: SHA_C,
      remoteSha: SHA_C,
    });
    const push = transport.execCommands.at(-2);
    expect(push?.argv.slice(-3)).toEqual([
      "push",
      "origin",
      `${SHA_C}:refs/heads/feature/ssh`,
    ]);
  });

  it("requires reconciliation when an ambiguous remote push resolves elsewhere", async () => {
    queueRepository(transport);
    transport.execResults.push(
      remoteResult(`${SHA_C}\n`),
      remoteResult(`${SHA_A}\trefs/heads/feature/ssh\n`),
      remoteResult("", 1),
      remoteResult(`${SHA_D}\trefs/heads/feature/ssh\n`),
    );

    await expect(
      executor.pushBranch({
        workspaceId: "test",
        branch: "feature/ssh",
        expectedLocalSha: SHA_C,
        remote: "origin",
        expectedRemoteSha: SHA_A,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_RECONCILIATION_REQUIRED" });
  });

  it("reads authorized GitHub repository, commit checks and pull-request metadata through the remote API", async () => {
    transport.githubApiResults.push(
      githubResponse(githubRepositoryRecord()),
      githubResponse({ total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", details_url: null, started_at: null, completed_at: null }] }),
      githubResponse(githubPullRequestRecord()),
    );

    await expect(
      executor.getRepository({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
      }),
    ).resolves.toEqual({
      owner: "octo",
      name: "repo",
      fullName: "octo/repo",
      defaultBranch: "main",
      visibility: "private",
      url: "https://github.com/octo/repo",
    });

    await expect(
      executor.getCommitChecks({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
        commitSha: SHA_C,
      }),
    ).resolves.toMatchObject({
      commitSha: SHA_C,
      totalCount: 1,
      passed: true,
      allCompleted: true,
    });

    await expect(
      executor.getPullRequest({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
        pullNumber: 7,
      }),
    ).resolves.toMatchObject({
      number: 7,
      state: "open",
      headSha: SHA_C,
      baseSha: SHA_A,
      merged: false,
    });

    expect(transport.githubApiCalls.map((entry) => entry.request.path)).toEqual([
      "/repos/octo/repo",
      `/repos/octo/repo/commits/${SHA_C}/check-runs?per_page=100`,
      "/repos/octo/repo/pulls/7",
    ]);
  });

  it("persists and exposes an immediately completed GitHub commit-check watch", async () => {
    transport.githubApiResults.push(
      githubResponse({
        total_count: 1,
        check_runs: [{
          id: 1,
          name: "ci",
          status: "completed",
          conclusion: "success",
          details_url: null,
          started_at: null,
          completed_at: null,
        }],
      }),
    );

    const started = await executor.startCommitChecksWatch(
      {
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
        commitSha: SHA_C,
        timeoutMs: 30_000,
      },
      { ownerScope: "owner-a" },
    );
    expect(started.status).toBe("started");
    expect(started.watch).toMatchObject({
      workspaceId: "test",
      owner: "octo",
      repository: "repo",
      commitSha: SHA_C,
      state: "passed",
      pollCount: 1,
    });

    await expect(
      executor.getCommitChecksWatches(
        { workspaceId: "test", ids: [started.watch.id] },
        { ownerScope: "owner-a" },
      ),
    ).resolves.toMatchObject({
      watches: [{ id: started.watch.id, state: "passed" }],
      truncated: false,
    });
    await expect(
      executor.waitCommitChecksWatch(
        { workspaceId: "test", id: started.watch.id, timeoutMs: 1 },
        { ownerScope: "owner-a" },
      ),
    ).resolves.toMatchObject({
      timedOut: false,
      watch: { id: started.watch.id, state: "passed" },
    });

    expect(transport.githubApiCalls.map((entry) => entry.request.path)).toContain(
      `/repos/octo/repo/commits/${SHA_C}/check-runs?per_page=100`,
    );
  });

  it("authorizes the canonical GitHub repository resolved from the remote origin", async () => {
    const canonicalExecutor = await SshWorkspaceExecutor.create({
      policy: {
        version: 1,
        workspaces: [
          {
            id: "test",
            name: "Test",
            rootPath: "C:\\workspace",
            workspaceKind: "repository",
            enabled: true,
            permissionProfile: "full-repo-write",
            confirmationMode: "standard",
            allowedRoots: ["."],
            blockedGlobs: [],
            limits: {
              maxFileBytes: 64_000,
              maxSearchResults: 100,
              maxSearchSnippetBytes: 20_000,
              maxDiffBytes: 500_000,
              maxListedFiles: 500,
            },
            allowWrites: ["."],
            allowShell: ["."],
            allowedShells: ["powershell", "pwsh"],
            sourceControl: {
              capabilities: ["github.repository.read"],
              accountOwners: [],
              additionalRepositories: [],
            },
          },
        ],
      },
      backgroundStateDirectory: stateDirectory,
      transport: transport as unknown as SshWindowsTransport,
    });

    queueRepository(transport);
    transport.execResults.push(
      remoteResult("git@github.com:octo/repo.git\n"),
    );
    transport.githubApiResults.push(
      githubResponse(githubRepositoryRecord()),
    );

    await expect(
      canonicalExecutor.getRepository({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
      }),
    ).resolves.toMatchObject({
      fullName: "octo/repo",
    });

    expect(transport.execCommands.at(-1)?.argv).toEqual([
      "remote",
      "get-url",
      "origin",
    ]);
  });

  it("denies GitHub repositories outside canonical/additional policy before API dispatch", async () => {
    await expect(
      executor.getRepository({
        workspaceId: "test",
        owner: "other",
        repository: "repo",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });

    expect(transport.githubApiCalls).toHaveLength(0);
  });

  it("requires typed confirmation for repository creation and replays the completed receipt", async () => {
    const input = {
      workspaceId: "test",
      owner: "octo",
      name: "created-repo",
      visibility: "private" as const,
      description: "remote typed repo",
    };

    const pending = await executor.createRepository(input, {
      invocationId: "repo-create-initial",
    });
    expect(pending).toMatchObject({
      status: "confirmation_required",
      operation: "github_create_repository",
      targetResource: "github:octo/created-repo",
    });
    expect(transport.githubApiCalls).toHaveLength(0);
    if (pending.status !== "confirmation_required") {
      throw new Error("expected confirmation");
    }

    transport.githubApiResults.push(
      githubResponse({ login: "octo" }),
      githubResponse(githubRepositoryRecord("octo", "created-repo")),
    );
    const confirmedInput = {
      ...input,
      confirmationId: pending.confirmationId,
    };
    const completed = await executor.createRepository(confirmedInput, {
      invocationId: "repo-create-confirmed",
    });
    expect(completed).toMatchObject({
      status: "completed",
      owner: "octo",
      name: "created-repo",
    });
    expect(transport.githubApiCalls).toHaveLength(2);

    const replay = await executor.createRepository(confirmedInput, {
      invocationId: "repo-create-replay",
    });
    expect(replay).toEqual(completed);
    expect(transport.githubApiCalls).toHaveLength(2);
  });

  it("requires typed confirmation for PR creation in standard mode", async () => {
    const input = {
      workspaceId: "test",
      owner: "octo",
      repository: "repo",
      title: "SSH PR",
      head: "feature/ssh-github",
      base: "main",
      draft: false,
    };

    const pending = await executor.createPullRequest(input, {
      invocationId: "pr-create-initial",
    });
    expect(pending).toMatchObject({
      status: "confirmation_required",
      operation: "github_create_pull_request",
    });
    if (pending.status !== "confirmation_required") {
      throw new Error("expected confirmation");
    }

    transport.githubApiResults.push(githubResponse(githubPullRequestRecord()));
    await expect(
      executor.createPullRequest(
        { ...input, confirmationId: pending.confirmationId },
        { invocationId: "pr-create-confirmed" },
      ),
    ).resolves.toMatchObject({
      status: "completed",
      number: 7,
      headSha: SHA_C,
    });
  });

  it("checks exact PR head before merge and reconciles an ambiguous remote merge", async () => {
    const input = {
      workspaceId: "test",
      owner: "octo",
      repository: "repo",
      pullNumber: 7,
      expectedPullRequestHeadSha: SHA_C,
      mergeMethod: "squash" as const,
    };

    const pending = await executor.mergePullRequest(input, {
      invocationId: "pr-merge-initial",
    });
    expect(pending).toMatchObject({
      status: "confirmation_required",
      operation: "github_merge_pull_request",
    });
    if (pending.status !== "confirmation_required") {
      throw new Error("expected confirmation");
    }

    transport.githubApiResults.push(
      githubResponse(githubPullRequestRecord()),
      new Error("ambiguous remote transport"),
      githubResponse(
        githubPullRequestRecord({
          state: "closed",
          merged: true,
          merge_commit_sha: SHA_D,
        }),
      ),
    );

    await expect(
      executor.mergePullRequest(
        { ...input, confirmationId: pending.confirmationId },
        { invocationId: "pr-merge-confirmed" },
      ),
    ).resolves.toEqual({
      status: "completed",
      number: 7,
      merged: true,
      mergeSha: SHA_D,
    });
  });

  it("rejects mismatched typed confirmations before remote GitHub mutation", async () => {
    const first = await executor.createRepository(
      {
        workspaceId: "test",
        owner: "octo",
        name: "first-repo",
        visibility: "private",
      },
      { invocationId: "confirm-first" },
    );
    if (first.status !== "confirmation_required") {
      throw new Error("expected confirmation");
    }

    await expect(
      executor.createRepository(
        {
          workspaceId: "test",
          owner: "octo",
          name: "different-repo",
          visibility: "private",
          confirmationId: first.confirmationId,
        },
        { invocationId: "confirm-mismatch" },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CONFIRMATION_INVALID" });
    expect(transport.githubApiCalls).toHaveLength(0);
  });
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
