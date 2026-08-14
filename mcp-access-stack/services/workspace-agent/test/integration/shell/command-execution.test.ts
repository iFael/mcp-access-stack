import { access, readFile } from "node:fs/promises";
import { afterEach, describe, expect, test, jest } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import { CommandConfirmationRegistry } from "../../../src/shell/confirmation.js";
import { classifyCommandRisk } from "../../../src/shell/command-risk.js";
import {
  createFixture,
  git,
  initializeGitRepository,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

jest.setTimeout(15_000);

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("command risk classifier", () => {
  test("flags destructive and mutating command families", () => {
    expect(classifyCommandRisk("powershell", "Remove-Item file.txt -Force")).toMatchObject({
      destructive: true,
    });
    expect(classifyCommandRisk("cmd", "git reset --hard HEAD")).toMatchObject({
      destructive: true,
    });
    expect(classifyCommandRisk("powershell", "Get-ChildItem src")).toEqual({
      destructive: false,
      reasons: [],
    });
    expect(classifyCommandRisk("powershell", "Format-Volume -DriveLetter E")).toMatchObject({
      destructive: true,
    });
    expect(classifyCommandRisk("cmd", "format.com E: /Q")).toMatchObject({
      destructive: true,
    });
  });

  test("keeps read-only PowerShell formatters non-destructive", () => {
    for (const command of [
      "Get-Process | Format-Table",
      "Get-Service | Format-List",
    ]) {
      expect(classifyCommandRisk("powershell", command)).toEqual({
        destructive: false,
        reasons: [],
      });
    }
  });

  test("flags option-prefixed, aliased and indirect execution variants", () => {
    const riskyCommands = [
      ["powershell", "git -C repo reset --hard HEAD"],
      ["powershell", "docker --context prod system prune -af"],
      ["powershell", "npm --prefix app install"],
      ["cmd", "cmd /c del file.txt"],
      ["powershell", "ri file.txt -Force"],
      ["powershell", "& $scriptPath"],
      ["cmd", "echo ok > output.txt"],
    ] as const;

    for (const [shell, command] of riskyCommands) {
      expect(classifyCommandRisk(shell, command)).toMatchObject({ destructive: true });
    }

    expect(classifyCommandRisk("powershell", "git -C repo status --short")).toEqual({
      destructive: false,
      reasons: [],
    });
    expect(classifyCommandRisk("powershell", "docker --context local ps")).toEqual({
      destructive: false,
      reasons: [],
    });
    expect(classifyCommandRisk("powershell", "Get-Content package.json")).toEqual({
      destructive: false,
      reasons: [],
    });
  });
});

describe("command confirmations", () => {
  test("consumes matching confirmations once", () => {
    const registry = new CommandConfirmationRegistry(60_000);
    const binding = {
      workspaceId: "test",
      shell: "powershell" as const,
      cwd: ".",
      command: "Remove-Item file.txt",
    };
    const confirmation = registry.create(binding);

    expect(() => registry.consume(confirmation.confirmationId, binding)).not.toThrow();
    expect(() => registry.consume(confirmation.confirmationId, binding)).toThrow(
      /missing or expired/,
    );
  });

  test("rejects binding mismatches without consuming the valid confirmation", () => {
    const registry = new CommandConfirmationRegistry(60_000);
    const binding = {
      workspaceId: "test",
      shell: "powershell" as const,
      cwd: ".",
      command: "Remove-Item file.txt",
    };
    const confirmation = registry.create(binding);

    expect(() =>
      registry.consume(confirmation.confirmationId, {
        ...binding,
        command: "Remove-Item other.txt",
      }),
    ).toThrow(/does not match/);
    expect(() => registry.consume(confirmation.confirmationId, binding)).not.toThrow();
  });

  test("expires confirmations", () => {
    jest.useFakeTimers();
    try {
      const registry = new CommandConfirmationRegistry(1_000);
      const binding = {
        workspaceId: "test",
        shell: "powershell" as const,
        cwd: ".",
        command: "Remove-Item file.txt",
      };
      const confirmation = registry.create(binding);
      jest.advanceTimersByTime(1_001);

      expect(() => registry.consume(confirmation.confirmationId, binding)).toThrow(
        /missing or expired/,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("run command", () => {
  test("executes safe commands directly", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.runCommand({
        workspaceId: "test",
        shell: "powershell",
        command: "Write-Output 'agent-shell-ok'",
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({
      status: "executed",
      shell: "powershell",
      cwd: ".",
      exitCode: 0,
    });
  });

  test("requires and consumes confirmation for risky commands", async () => {
    fixture = await createWritableShellFixture();
    await writeWorkspaceFile(fixture.workspacePath, "danger.txt", "remove me");
    const agent = await LocalAgent.create(fixture.policyPath);
    const command = "Remove-Item 'danger.txt' -Force";

    const first = await agent.runCommand({
      workspaceId: "test",
      shell: "powershell",
      command,
      timeoutMs: 30_000,
    });

    expect(first).toMatchObject({
      status: "confirmation_required",
      shell: "powershell",
      cwd: ".",
    });
    if (first.status !== "confirmation_required") {
      throw new Error("Expected confirmation_required");
    }

    await expect(
      agent.runCommand({
        workspaceId: "test",
        shell: "powershell",
        command,
        confirmationId: "wrong",
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFIRMATION_INVALID" });

    await expect(
      agent.runCommand({
        workspaceId: "test",
        shell: "powershell",
        command,
        confirmationId: first.confirmationId,
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({ status: "executed", exitCode: 0 });

    await expect(access(`${fixture.workspacePath}/danger.txt`)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      agent.runCommand({
        workspaceId: "test",
        shell: "powershell",
        command,
        confirmationId: first.confirmationId,
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFIRMATION_INVALID" });
  });

  test("permanently blocks pushes involving main", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.runCommand({
        workspaceId: "test",
        shell: "powershell",
        command: "git push origin main",
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("requires confirmation before pushing any non-main branch", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.runCommand({
        workspaceId: "test",
        shell: "powershell",
        command: "git push origin feature/safe",
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({
      status: "confirmation_required",
      reasons: expect.arrayContaining(["git push requires explicit user confirmation"]),
    });
  });

  test("keeps explicit direct mode on the existing execution path", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.runCommand({
        workspaceId: "test",
        shell: "powershell",
        command: "Write-Output 'direct-mode-ok'",
        executionMode: "direct",
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({
      status: "executed",
      shell: "powershell",
      exitCode: 0,
      stdout: expect.stringContaining("direct-mode-ok"),
    });
  });

  test("rejects qualified mode before starting a process", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.runCommand({
        workspaceId: "test",
        objective: "Executar um comando que n├úo deve iniciar",
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
      message: "Qualified command execution is disabled.",
    });
  });

  test("keeps the run_powershell alias on the same confirmation path", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);
    await expect(agent.runPowerShell({ workspaceId: "test", command: "Remove-Item 'missing.txt' -Force", timeoutMs: 30_000 })).resolves.toMatchObject({ status: "confirmation_required", shell: "powershell" });
  });

  test("executes bounded local mutations without confirmation in trusted workspace", async () => {
    fixture = await createWritableShellFixture("trusted-workspace");
    const agent = await LocalAgent.create(fixture.policyPath);
    for (const command of [
      "New-Item -ItemType File -Path 'trusted-file.txt'",
      "Set-Content -LiteralPath 'trusted-file.txt' -Value 'updated'",
      "Move-Item -LiteralPath 'trusted-file.txt' -Destination 'trusted-moved.txt'",
      "New-Item -ItemType Directory -Path 'trusted-dir'",
      "Set-Content -LiteralPath 'trusted-dir/child.txt' -Value 'child'",
      "Remove-Item -LiteralPath 'trusted-dir' -Recurse -Force",
      "Remove-Item -LiteralPath 'trusted-moved.txt' -Force",
    ]) {
      await expect(agent.runCommand({ workspaceId: "test", shell: "powershell", command, timeoutMs: 30_000 })).resolves.toMatchObject({ status: "executed", exitCode: 0 });
    }
    await expect(access(`${fixture.workspacePath}/trusted-moved.txt`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${fixture.workspacePath}/trusted-dir`)).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  test("executes bounded Git index and cleanup operations without confirmation in trusted workspace", async () => {
    fixture = await createWritableShellFixture("trusted-workspace");
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "tracked.txt", "before\n");
    git(fixture.workspacePath, ["add", "--", "tracked.txt"]);
    git(fixture.workspacePath, ["commit", "-m", "fixture"]);
    await writeWorkspaceFile(fixture.workspacePath, "tracked.txt", "after\n");
    const agent = await LocalAgent.create(fixture.policyPath);
    await expect(agent.runCommand({ workspaceId: "test", shell: "powershell", command: "git add -- tracked.txt", timeoutMs: 30_000 })).resolves.toMatchObject({ status: "executed", exitCode: 0 });
    await expect(agent.runCommand({ workspaceId: "test", shell: "powershell", command: "git restore --staged -- tracked.txt", timeoutMs: 30_000 })).resolves.toMatchObject({ status: "executed", exitCode: 0 });
    expect(git(fixture.workspacePath, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    expect((await readFile(`${fixture.workspacePath}/tracked.txt`, "utf8")).trim()).toBe("after");
    await expect(agent.runCommand({ workspaceId: "test", shell: "powershell", command: "git add -- tracked.txt", timeoutMs: 30_000 })).resolves.toMatchObject({ status: "executed", exitCode: 0 });
    await expect(agent.runCommand({ workspaceId: "test", shell: "powershell", command: "git reset HEAD -- tracked.txt", timeoutMs: 30_000 })).resolves.toMatchObject({ status: "executed", exitCode: 0 });
    await writeWorkspaceFile(fixture.workspacePath, "untracked.txt", "temporary\n");
    await expect(agent.runCommand({ workspaceId: "test", shell: "powershell", command: "git clean -f -- untracked.txt", timeoutMs: 30_000 })).resolves.toMatchObject({ status: "executed", exitCode: 0 });
    await expect(access(`${fixture.workspacePath}/untracked.txt`)).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  test("blocks protected paths and keeps ambiguous traversal on confirmation in trusted workspace", async () => {
    fixture = await createWritableShellFixture("trusted-workspace");
    await writeWorkspaceFile(fixture.workspacePath, "secret/.env", "SECRET=value\n");
    const agent = await LocalAgent.create(fixture.policyPath);
    await expect(agent.runCommand({ workspaceId: "test", shell: "powershell", command: "Remove-Item -LiteralPath 'secret' -Recurse -Force", timeoutMs: 30_000 })).rejects.toMatchObject({ code: "BLOCKED_PATH" });
    await expect(agent.runCommand({ workspaceId: "test", shell: "powershell", command: "Remove-Item '..\\outside.txt' -Force", timeoutMs: 30_000 })).resolves.toMatchObject({ status: "confirmation_required" });
  });
});

async function createWritableShellFixture(confirmationMode: "standard" | "trusted-workspace" = "standard"): Promise<Fixture> {
  const created = await createFixture({ profile: "full-repo-write", allowedRoots: ["."], confirmationMode });
  await writePolicy(created.policyPath, [{ ...makeWorkspacePolicy(created.workspacePath, { profile: "full-repo-write", allowedRoots: ["."], confirmationMode }), allowWrites: ["."], allowShell: ["."], allowedShells: ["powershell"] }]);
  return created;
}