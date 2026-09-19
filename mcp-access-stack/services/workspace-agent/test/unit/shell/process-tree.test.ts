import { describe, expect, jest, test, afterEach } from "@jest/globals";
import {
  COMMAND_TERMINATION_GRACE_MS,
  createOperationDeadline,
} from "@vs-code-gpt/shared";

const spawnMock = jest.fn();

jest.unstable_mockModule("node:child_process", () => ({
  spawn: spawnMock,
}));

const { terminateProcessTreeByPid } = await import(
  "../../../src/process/process-tree.js"
);

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  spawnMock.mockReset();
});

const windowsTest = process.platform === "win32" ? test : test.skip;

describe("Windows process tree termination failure", () => {
  windowsTest("reports SHELL_FAILED with command lifecycle when termination grace is exhausted", async () => {

    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-19T00:00:00.000Z"));

    spawnMock.mockImplementation((executable: string) =>
      executable.toLocaleLowerCase("en-US").endsWith("taskkill.exe")
        ? fakeChild(1)
        : fakeChild(0),
    );
    jest.spyOn(process, "kill").mockImplementation(() => true);

    const startedAt = Date.now();
    const deadline = createOperationDeadline(1_000, undefined, startedAt);
    const termination = terminateProcessTreeByPid(4242, {
      deadline,
      startedAt,
    });
    const rejection = expect(termination).rejects.toMatchObject({
      code: "SHELL_FAILED",
      message:
        "The Windows process tree did not terminate within the command termination grace period.",
      lifecycle: {
        requestedTimeoutMs: 1_000,
        effectiveTimeoutMs: 1_000,
        terminatedBy: "child_process",
        reason: "process_failed",
        diagnostic:
          "The Windows process tree did not terminate within the command termination grace period.",
      },
    });

    await jest.advanceTimersByTimeAsync(COMMAND_TERMINATION_GRACE_MS + 1);
    await rejection;
  });
});

function fakeChild(exitCode: number) {
  const child = {
    stdout: {
      on: jest.fn(() => child.stdout),
    },
    kill: jest.fn(() => true),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "close") listener(exitCode);
      return child;
    }),
  };
  return child;
}
