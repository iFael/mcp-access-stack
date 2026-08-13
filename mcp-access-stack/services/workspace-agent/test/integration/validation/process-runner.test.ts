import { describe, expect, test } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import {
  executeProcess,
  isExecutableNotFound,
  readToolVersion,
  sanitizeToolError,
} from "../../../src/validation/process-runner.js";

describe("validation process runner", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const result = await executeProcess(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err');"],
      process.cwd(),
      5_000,
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "out",
      stderr: "err",
      timedOut: false,
      outputTruncated: false,
    });
  });

  test("marks a process that exceeds its timeout", async () => {
    const result = await executeProcess(
      process.execPath,
      ["-e", "setTimeout(() => undefined, 5_000);"],
      process.cwd(),
      25,
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test("rejects an already cancelled validation", async () => {
    const controller = new AbortController();
    controller.abort(new AppError("AGENT_TIMEOUT", "deadline reached"));

    await expect(
      executeProcess(process.execPath, ["--version"], process.cwd(), 5_000, controller.signal),
    ).rejects.toMatchObject({ code: "AGENT_TIMEOUT", message: "deadline reached" });
  });

  test("reads the first line of a tool version", async () => {
    await expect(
      readToolVersion(process.execPath, ["--version"], process.cwd()),
    ).resolves.toMatch(/^v\d+/);
  }, 30_000);

  test("sanitizes tool errors without exposing additional lines", () => {
    expect(sanitizeToolError("\n first failure \nsecond failure", "fallback")).toBe(
      "first failure",
    );
    expect(sanitizeToolError("\n\r", "fallback")).toBe("fallback");
  });

  test("recognizes executable-not-found errors", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(isExecutableNotFound(error)).toBe(true);
    expect(isExecutableNotFound(new Error("other"))).toBe(false);
  });
});
