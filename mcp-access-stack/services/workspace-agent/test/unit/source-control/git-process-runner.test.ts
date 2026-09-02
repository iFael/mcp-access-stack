import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, jest } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import {
  HardenedGitProcessRunner,
  resolveGitExecutable,
  type GitSpawnProcess,
} from "../../../src/source-control/git-process-runner.js";

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof jest.fn>;
}

function fakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  return child;
}

function complete(
  child: FakeChild,
  options: { stdout?: string; stderr?: string; code?: number } = {},
): void {
  queueMicrotask(() => {
    if (options.stdout) child.stdout.write(options.stdout);
    if (options.stderr) child.stderr.write(options.stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", options.code ?? 0);
  });
}

function absoluteGitForTest(): string {
  const root = path.parse(process.cwd()).root;
  return path.join(root, "controlled", process.platform === "win32" ? "git.exe" : "git");
}

describe("HardenedGitProcessRunner", () => {
  it("resolves the runtime Git executable to an absolute path", async () => {
    const resolved = await resolveGitExecutable();
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(path.basename(resolved).toLowerCase()).toMatch(/^git(?:\.exe)?$/u);
  });

  it("spawns an absolute executable with shell false and an allowlisted environment", async () => {
    const child = fakeChild();
    const spawnProcess = jest.fn((executable: string, args: readonly string[], options: Record<string, unknown>) => {
      complete(child, { stdout: `${"a".repeat(40)}\n` });
      return child as never;
    });
    const runner = new HardenedGitProcessRunner({
      gitExecutable: absoluteGitForTest(),
      spawnProcess: spawnProcess as unknown as GitSpawnProcess,
      baseEnvironment: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot,
        USERPROFILE: process.env.USERPROFILE,
        HOME: process.env.HOME,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        SSH_AUTH_SOCK: "agent.sock",
        GITHUB_TOKEN: "must-not-leak",
        GH_TOKEN: "must-not-leak",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-leak",
        ACTIONS_ID_TOKEN_REQUEST_URL: "must-not-leak",
        GIT_ASKPASS: "must-not-leak",
        SSH_ASKPASS: "must-not-leak",
        GIT_CONFIG_GLOBAL: "must-not-leak",
        GIT_CONFIG_SYSTEM: "must-not-leak",
        GIT_SSH_COMMAND: "must-not-leak",
      },
    });

    await expect(runner.headSha(process.cwd())).resolves.toBe("a".repeat(40));

    const [executable, args, options] = spawnProcess.mock.calls[0]!;
    expect(path.isAbsolute(executable)).toBe(true);
    expect(args).toEqual(["rev-parse", "HEAD"]);
    expect(options).toMatchObject({
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const env = (options as { env: Record<string, string | undefined> }).env;
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_PAGER: "cat",
    });
    expect(env.SSH_AUTH_SOCK).toBe("agent.sock");
    for (const forbidden of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_SSH_COMMAND",
    ]) {
      expect(env[forbidden]).toBeUndefined();
    }
    expect("run" in runner).toBe(false);
    expect("execute" in runner).toBe(false);
  });

  it("constructs only fixed unstage, merge and non-force push argv", async () => {
    const calls: Array<readonly string[]> = [];
    const spawnProcess = jest.fn((_executable: string, args: readonly string[]) => {
      calls.push([...args]);
      const child = fakeChild();
      complete(child);
      return child as never;
    }) as unknown as GitSpawnProcess;
    const runner = new HardenedGitProcessRunner({
      gitExecutable: absoluteGitForTest(),
      spawnProcess: spawnProcess as unknown as GitSpawnProcess,
    });
    const sha = "b".repeat(40);

    await runner.unstagePaths(process.cwd(), ["src/a.ts", "src/b.ts"]);
    await runner.mergeFastForward(process.cwd(), sha);
    await runner.pushBranch(process.cwd(), "origin", "feature/task4", sha);

    expect(calls[0]!.slice(-5)).toEqual(["restore", "--staged", "--", "src/a.ts", "src/b.ts"]);
    expect(calls[1]!.slice(-3)).toEqual(["merge", "--ff-only", sha]);
    expect(calls[2]!.slice(-3)).toEqual(["push", "origin", `${sha}:refs/heads/feature/task4`]);
    for (const call of calls) {
      expect(call.some((argument) => argument.startsWith("core.hooksPath="))).toBe(true);
      expect(call).toContain("commit.gpgSign=false");
      expect(call).toContain("merge.gpgSign=false");
    }
    expect(calls.flat().some((argument) => argument.includes("force"))).toBe(false);
  });

  it("terminates the process tree when its signal is aborted", async () => {
    const child = fakeChild();
    const terminateProcessTree = jest.fn(async () => {
      child.emit("close", null);
    });
    const spawnProcess = jest.fn(() => child as never) as unknown as GitSpawnProcess;
    const runner = new HardenedGitProcessRunner({
      gitExecutable: absoluteGitForTest(),
      spawnProcess: spawnProcess as unknown as GitSpawnProcess,
      terminateProcessTree,
    });
    const controller = new AbortController();
    const pending = runner.headSha(process.cwd(), controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it("preserves a timeout AppError reason while terminating the child tree", async () => {
    const child = fakeChild();
    const terminateProcessTree = jest.fn(async () => {
      child.emit("close", null);
    });
    const runner = new HardenedGitProcessRunner({
      gitExecutable: absoluteGitForTest(),
      spawnProcess: jest.fn(() => child as never) as unknown as GitSpawnProcess,
      terminateProcessTree,
    });
    const controller = new AbortController();
    const timeout = new AppError("AGENT_TIMEOUT", "Git deadline has expired.");
    const pending = runner.headSha(process.cwd(), controller.signal);

    controller.abort(timeout);

    await expect(pending).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it("never exposes raw Git stderr through the public AppError", async () => {
    const child = fakeChild();
    const spawnProcess = jest.fn(() => {
      complete(child, {
        stderr: "Authorization: Bearer raw-secret-token\nprovider response secret-body",
        code: 128,
      });
      return child as never;
    }) as unknown as GitSpawnProcess;
    const runner = new HardenedGitProcessRunner({
      gitExecutable: absoluteGitForTest(),
      spawnProcess: spawnProcess as unknown as GitSpawnProcess,
    });

    let captured: unknown;
    try {
      await runner.headSha(process.cwd());
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({ code: "GIT_ERROR", message: "Git command failed." });
    expect(JSON.stringify(captured)).not.toContain("raw-secret-token");
    expect(JSON.stringify(captured)).not.toContain("secret-body");
    expect((captured as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("disables repository hooks and implicit signing for mutating Git commands", async () => {
    const child = fakeChild();
    const spawnProcess = jest.fn((_executable: string, _args: readonly string[]) => {
      complete(child);
      return child as never;
    });
    const runner = new HardenedGitProcessRunner({
      gitExecutable: absoluteGitForTest(),
      spawnProcess: spawnProcess as unknown as GitSpawnProcess,
    });

    await runner.commit(process.cwd(), "typed commit");

    const args = spawnProcess.mock.calls[0]![1];
    expect(args.some((argument) => argument.startsWith("core.hooksPath="))).toBe(true);
    expect(args).toContain("commit.gpgSign=false");
    expect(args).toContain("merge.gpgSign=false");
    expect(args.slice(-3)).toEqual(["commit", "-m", "typed commit"]);
  });
  it("classifies every nonzero push exit as an ambiguous mutation outcome", async () => {
    const child = fakeChild();
    const runner = new HardenedGitProcessRunner({
      gitExecutable: absoluteGitForTest(),
      spawnProcess: jest.fn(() => {
        complete(child, { code: 2 });
        return child as never;
      }) as unknown as GitSpawnProcess,
    });

    await expect(
      runner.pushBranch(process.cwd(), "origin", "feature/task4", "a".repeat(40)),
    ).rejects.toMatchObject({
      code: "GIT_ERROR",
      details: { outcome: "unknown" },
    });
  });

  it("classifies cancellation after push spawn as ambiguous and terminates the tree", async () => {
    const child = fakeChild();
    const terminateProcessTree = jest.fn(async () => {
      child.emit("close", null);
    });
    const runner = new HardenedGitProcessRunner({
      gitExecutable: absoluteGitForTest(),
      spawnProcess: jest.fn(() => child as never) as unknown as GitSpawnProcess,
      terminateProcessTree,
    });
    const controller = new AbortController();
    const pending = runner.pushBranch(
      process.cwd(),
      "origin",
      "feature/task4",
      "a".repeat(40),
      controller.signal,
    );

    controller.abort(new AppError("AGENT_TIMEOUT", "deadline"));

    await expect(pending).rejects.toMatchObject({
      code: "GIT_ERROR",
      details: { outcome: "unknown" },
    });
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });
});
