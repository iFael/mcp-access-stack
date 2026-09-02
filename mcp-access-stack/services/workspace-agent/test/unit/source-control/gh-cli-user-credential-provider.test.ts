import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, jest } from "@jest/globals";
import {
  GhCliUserCredentialProvider,
  type GhSpawnProcess,
} from "../../../src/source-control/gh-cli-user-credential-provider.js";

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof jest.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4200;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  return child;
}

function complete(child: FakeChild, options: { stdout?: string; stderr?: string; code?: number } = {}): void {
  queueMicrotask(() => {
    if (options.stdout) child.stdout.write(options.stdout);
    if (options.stderr) child.stderr.write(options.stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", options.code ?? 0);
  });
}

function absoluteGhForTest(): string {
  return path.join(path.parse(process.cwd()).root, "controlled", process.platform === "win32" ? "gh.exe" : "gh");
}
function absoluteGitForTest(): string {
  return path.join(path.parse(process.cwd()).root, "controlled", process.platform === "win32" ? "git.exe" : "git");
}

describe("GhCliUserCredentialProvider", () => {
  it("invokes only exact gh auth token with shell false and returns an opaque in-memory credential", async () => {
    const child = fakeChild();
    const spawnProcess = jest.fn((_executable: string, _args: readonly string[], _options: Record<string, unknown>) => {
      complete(child, { stdout: "unit-test-token\n" });
      return child as never;
    });
    const provider = new GhCliUserCredentialProvider({
      ghExecutable: absoluteGhForTest(),
      spawnProcess: spawnProcess as unknown as GhSpawnProcess,
      baseEnvironment: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        GH_TOKEN: "must-not-leak",
        GITHUB_TOKEN: "must-not-leak",
      },
    });

    await expect(provider.getCredential()).resolves.toEqual({
      token: "unit-test-token",
      source: "gh-cli-user",
    });

    const [executable, args, options] = spawnProcess.mock.calls[0]!;
    expect(path.isAbsolute(executable)).toBe(true);
    expect(args).toEqual(["auth", "token"]);
    expect(options).toMatchObject({ shell: false, windowsHide: true });
    const env = (options as { env: Record<string, string | undefined> }).env;
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect("run" in provider).toBe(false);
    expect("execute" in provider).toBe(false);
  });

  it("falls back to git credential fill when gh has no authenticated token", async () => {
    const ghChild = fakeChild();
    const gitChild = fakeChild();
    let gitInput = "";
    gitChild.stdin.on("data", (chunk) => {
      gitInput += chunk.toString("utf8");
    });
    const spawnProcess = jest.fn((_executable: string, args: readonly string[], _options: Record<string, unknown>) => {
      if (args[0] === "auth") {
        complete(ghChild, { stderr: "not authenticated", code: 1 });
        return ghChild as never;
      }
      complete(gitChild, {
        stdout: "protocol=https\nhost=github.com\nusername=test-user\npassword=git-unit-test-token\n\n",
      });
      return gitChild as never;
    });
    const provider = new GhCliUserCredentialProvider({
      ghExecutable: absoluteGhForTest(),
      gitExecutable: absoluteGitForTest(),
      spawnProcess: spawnProcess as unknown as GhSpawnProcess,
      baseEnvironment: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        GH_TOKEN: "must-not-leak",
        GITHUB_TOKEN: "must-not-leak",
      },
    });

    await expect(provider.getCredential()).resolves.toEqual({
      token: "git-unit-test-token",
      source: "git-credential-user",
    });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    const [gitExecutable, gitArgs, gitOptions] = spawnProcess.mock.calls[1]!;
    expect(gitExecutable).toBe(absoluteGitForTest());
    expect(gitArgs).toEqual(["credential", "fill"]);
    expect(gitOptions).toMatchObject({ shell: false, windowsHide: true });
    const env = (gitOptions as { env: Record<string, string | undefined> }).env;
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(gitInput).toBe("protocol=https\nhost=github.com\n\n");
  });
  it("rejects a relative gh executable path", () => {
    expect(
      () => new GhCliUserCredentialProvider({ ghExecutable: "gh" }),
    ).toThrow(/absolute/i);
  });

  it("bounds stdout and never exposes token-like stdout or raw stderr on failure", async () => {
    const child = fakeChild();
    const spawnProcess = jest.fn(() => {
      complete(child, {
        stdout: `${"x".repeat(20_000)}\n`,
        stderr: "raw provider failure unit-test-token",
        code: 1,
      });
      return child as never;
    });
    const provider = new GhCliUserCredentialProvider({
      ghExecutable: absoluteGhForTest(),
      spawnProcess,
      maxOutputBytes: 8_192,
    });

    let captured: unknown;
    try {
      await provider.getCredential();
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("unit-test-token");
    expect(serialized).not.toContain("raw provider failure");
    expect((captured as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
