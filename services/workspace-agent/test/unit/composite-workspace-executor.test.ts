import { describe, expect, it, jest } from "@jest/globals";
import type { RunCommandResult, WorkspaceSummary } from "@vs-code-gpt/shared";
import {
  CompositeWorkspaceExecutor,
  type RoutedWorkspaceExecutor,
} from "../../src/composite-workspace-executor.js";

function summary(id: string): WorkspaceSummary {
  return {
    id,
    name: id,
    workspaceKind: "repository",
    enabled: true,
    permissionProfile: "full-repo-write",
    confirmationMode: "trusted-workspace",
    writesEnabled: true,
    shellsEnabled: true,
    allowedShells: ["pwsh"],
  };
}

function executor(id: string, stdout: string) {
  const runCommand = jest.fn(async (): Promise<RunCommandResult> => ({
    status: "executed",
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
  }));
  const value = {
    listWorkspaces: async () => [summary(id)],
    runCommand,
  } as unknown as RoutedWorkspaceExecutor;
  return { value, runCommand };
}

describe("CompositeWorkspaceExecutor", () => {
  it("merges workspace discovery and routes operations by workspaceId", async () => {
    const oracle = executor("mcp-access-stack", "oracle\n");
    const windows = executor("rafael-windows", "windows\n");
    const composite = await CompositeWorkspaceExecutor.create([
      windows.value,
      oracle.value,
    ]);

    await expect(composite.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({ id: "mcp-access-stack" }),
      expect.objectContaining({ id: "rafael-windows" }),
    ]);

    const result = await composite.runCommand({
      workspaceId: "rafael-windows",
      shell: "pwsh",
      command: "hostname",
      cwd: ".",
      timeoutMs: 30_000,
    });

    expect(result).toMatchObject({ status: "executed", stdout: "windows\n" });
    expect(windows.runCommand).toHaveBeenCalledTimes(1);
    expect(oracle.runCommand).not.toHaveBeenCalled();
  });

  it("rejects duplicate workspace ids across executors", async () => {
    const first = executor("duplicate", "one\n");
    const second = executor("duplicate", "two\n");

    await expect(
      CompositeWorkspaceExecutor.create([first.value, second.value]),
    ).rejects.toMatchObject({
      code: "POLICY_INVALID",
    });
  });

  it("returns WORKSPACE_NOT_FOUND for an unknown route", async () => {
    const oracle = executor("mcp-access-stack", "oracle\n");
    const composite = await CompositeWorkspaceExecutor.create([oracle.value]);

    expect(() =>
      composite.runCommand({
        workspaceId: "missing",
        shell: "pwsh",
        command: "hostname",
        cwd: ".",
        timeoutMs: 30_000,
      }),
    ).toThrow(expect.objectContaining({
      code: "WORKSPACE_NOT_FOUND",
    }));
  });
});
