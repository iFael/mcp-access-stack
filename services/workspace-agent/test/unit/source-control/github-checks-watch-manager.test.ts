import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type GitHubCommitChecksResult } from "@vs-code-gpt/shared";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { GitHubCommitChecksWatchManager } from "../../../src/source-control/github-checks-watch-manager.js";

const SHA = "a".repeat(40);

function checks(
  overrides: Partial<GitHubCommitChecksResult> = {},
): GitHubCommitChecksResult {
  const base: GitHubCommitChecksResult = {
    owner: "octo",
    repository: "repo",
    commitSha: SHA,
    totalCount: 1,
    returnedCount: 1,
    pendingCount: 1,
    successfulCount: 0,
    failingCount: 0,
    truncated: false,
    allCompleted: false,
    passed: false,
    checks: [{
      id: 1,
      name: "ci",
      status: "in_progress",
      conclusion: null,
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
    }],
  };
  return { ...base, ...overrides };
}

function passedChecks(): GitHubCommitChecksResult {
  return checks({
    pendingCount: 0,
    successfulCount: 1,
    allCompleted: true,
    passed: true,
    checks: [{
      id: 1,
      name: "ci",
      status: "completed",
      conclusion: "success",
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
    }],
  });
}

describe("GitHubCommitChecksWatchManager", () => {
  let stateDirectory: string;
  const managers: GitHubCommitChecksWatchManager[] = [];

  beforeEach(async () => {
    stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "mcp-github-check-watch-"),
    );
  });

  afterEach(async () => {
    for (const manager of managers) manager.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it("polls to terminal success, preserves owner scope, and short-waits without cancelling", async () => {
    const responses = [checks(), passedChecks()];
    const poll = jest.fn(async () => responses.shift() ?? passedChecks());
    const manager = new GitHubCommitChecksWatchManager({
      stateDirectory,
      poll,
      pollIntervalMs: 10,
    });
    managers.push(manager);

    const started = await manager.start(
      {
        workspaceId: "ws",
        owner: "octo",
        repository: "repo",
        commitSha: SHA,
        timeoutMs: 30_000,
      },
      { ownerScope: "owner-a" },
    );
    expect(started.status).toBe("started");
    expect(started.watch).toMatchObject({
      state: "watching",
      pollCount: 1,
    });

    await expect(
      manager.get(
        { workspaceId: "ws", ids: [started.watch.id] },
        { ownerScope: "owner-b" },
      ),
    ).resolves.toEqual({ watches: [], truncated: false });

    const waited = await manager.wait(
      {
        workspaceId: "ws",
        id: started.watch.id,
        timeoutMs: 1_000,
      },
      { ownerScope: "owner-a" },
    );
    expect(waited.timedOut).toBe(false);
    expect(waited.watch).toMatchObject({
      state: "passed",
      pollCount: 2,
    });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("deduplicates an active watch for the same owner scope and immutable target", async () => {
    const poll = jest.fn(async () => checks());
    const manager = new GitHubCommitChecksWatchManager({
      stateDirectory,
      poll,
      pollIntervalMs: 10_000,
    });
    managers.push(manager);

    const first = await manager.start(
      {
        workspaceId: "ws",
        root: ".",
        owner: "octo",
        repository: "repo",
        commitSha: SHA,
        timeoutMs: 30_000,
      },
      { ownerScope: "owner-a" },
    );
    const second = await manager.start(
      {
        workspaceId: "ws",
        root: ".",
        owner: "octo",
        repository: "repo",
        commitSha: SHA,
        timeoutMs: 30_000,
      },
      { ownerScope: "owner-a" },
    );

    expect(second.status).toBe("existing");
    expect(second.watch.id).toBe(first.watch.id);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("recovers a persisted active watch after restart and resumes polling without shell state", async () => {
    const firstPoll = jest.fn(async () => checks());
    const first = new GitHubCommitChecksWatchManager({
      stateDirectory,
      poll: firstPoll,
      pollIntervalMs: 60_000,
    });
    managers.push(first);
    const started = await first.start(
      {
        workspaceId: "ws",
        owner: "octo",
        repository: "repo",
        commitSha: SHA,
        timeoutMs: 30_000,
      },
      { ownerScope: "owner-a" },
    );
    first.close();

    const resumedContexts: Array<string | undefined> = [];
    const second = new GitHubCommitChecksWatchManager({
      stateDirectory,
      poll: async (_input, context) => {
        resumedContexts.push(context.ownerScope);
        return passedChecks();
      },
      pollIntervalMs: 10,
    });
    managers.push(second);
    await second.recover();

    const waited = await second.wait(
      {
        workspaceId: "ws",
        id: started.watch.id,
        timeoutMs: 1_000,
      },
      { ownerScope: "owner-a" },
    );
    expect(waited.timedOut).toBe(false);
    expect(waited.watch.state).toBe("passed");
    expect(waited.watch.pollCount).toBe(2);
    expect(resumedContexts).toEqual([undefined]);
  });

  it("fails closed when the check-run set is truncated", async () => {
    const manager = new GitHubCommitChecksWatchManager({
      stateDirectory,
      poll: async () =>
        checks({
          totalCount: 101,
          returnedCount: 100,
          pendingCount: 0,
          successfulCount: 100,
          failingCount: 0,
          truncated: true,
          allCompleted: false,
          passed: false,
          checks: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: `check-${index + 1}`,
            status: "completed" as const,
            conclusion: "success" as const,
            detailsUrl: null,
            startedAt: null,
            completedAt: null,
          })),
        }),
      pollIntervalMs: 10,
    });
    managers.push(manager);

    const started = await manager.start({
      workspaceId: "ws",
      owner: "octo",
      repository: "repo",
      commitSha: SHA,
      timeoutMs: 30_000,
    });
    expect(started.watch).toMatchObject({
      state: "error",
      lastError: { code: "EXECUTION_STATE_INVALID" },
    });
  });

  it("returns TASK_NOT_FOUND for inaccessible waits", async () => {
    const manager = new GitHubCommitChecksWatchManager({
      stateDirectory,
      poll: async () => checks(),
      pollIntervalMs: 60_000,
    });
    managers.push(manager);
    const started = await manager.start(
      {
        workspaceId: "ws",
        owner: "octo",
        repository: "repo",
        commitSha: SHA,
        timeoutMs: 30_000,
      },
      { ownerScope: "owner-a" },
    );

    await expect(
      manager.wait(
        {
          workspaceId: "ws",
          id: started.watch.id,
          timeoutMs: 1,
        },
        { ownerScope: "owner-b" },
      ),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});
