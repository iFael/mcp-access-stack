import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { LocalAgent } from "../../../src/index.js";
import type {
  ProviderCommandProposal,
  ProviderRepairProposal,
  QualifiedCommandProvider,
} from "../../../src/shell/qualified/command-provider.js";
import {
  createFixture,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

jest.setTimeout(180_000);

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

function enabledOptions(
  stateDirectory: string,
  safeAutoCorrection = false,
) {
  return {
    qualifiedCommandFeatures: {
      qualifiedExecution: true,
      safeAutoCorrection,
    },
    qualifiedInvocationStateDirectory: stateDirectory,
  };
}

describe("qualified run command", () => {
  test("executes one sanitized attempt and persists only the redacted response", async () => {
    fixture = await createWritableShellFixture();
    const stateDirectory = path.join(fixture.basePath, "command-invocations");
    const agent = await LocalAgent.create(
      fixture.policyPath,
      enabledOptions(stateDirectory),
    );

    const result = await agent.runCommand(
      {
        workspaceId: "test",
        command: "echo 'token=supersecret'",
        shell: "powershell",
        executionMode: "qualified",
        expectedOutcome: [
          {
            kind: "text_contains",
            stream: "stdout",
            value: "token=[REDACTED]",
          },
        ],
        timeoutMs: 120_000,
      },
      { invocationId: "sanitize-output" },
    );

    expect(result).toMatchObject({
      status: "executed",
      executionMode: "qualified",
      corrected: false,
      attemptCount: 1,
      stdout: expect.stringContaining("token=[REDACTED]"),
      postcondition: { passed: true, checked: 1, failed: 0 },
      attempts: [
        expect.objectContaining({
          attempt: 1,
          shell: "powershell",
          cwd: ".",
          exitCode: 0,
          timedOut: false,
        }),
      ],
    });
    if (result.status !== "executed") {
      throw new Error("Expected an executed qualified result.");
    }
    expect(result.stdout).not.toContain("supersecret");

    const files = (await readdir(stateDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
    const persisted = await readFile(path.join(stateDirectory, files[0]!), "utf8");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain("supersecret");
  });

  test("requires confirmation, executes a mutation once and replays it after restart", async () => {
    fixture = await createWritableShellFixture();
    await writeWorkspaceFile(fixture.workspacePath, "counter.txt", "0");
    const stateDirectory = path.join(fixture.basePath, "command-invocations");
    const options = enabledOptions(stateDirectory);
    const firstAgent = await LocalAgent.create(fixture.policyPath, options);
    const command =
      "$value = [int](Get-Content 'counter.txt'); Set-Content 'counter.txt' ($value + 1); Write-Output 'incremented'";
    const input = {
      workspaceId: "test",
      command,
      shell: "powershell" as const,
      executionMode: "qualified" as const,
      timeoutMs: 120_000,
    };
    const context = { invocationId: "single-mutation" };

    const confirmation = await firstAgent.runCommand(input, context);
    expect(confirmation).toMatchObject({
      status: "confirmation_required",
      executionMode: "qualified",
      corrected: false,
    });
    if (confirmation.status !== "confirmation_required") {
      throw new Error("Expected confirmation_required.");
    }

    const executed = await firstAgent.runCommand(
      { ...input, confirmationId: confirmation.confirmationId },
      context,
    );
    expect(executed).toMatchObject({
      status: "executed",
      executionMode: "qualified",
      corrected: false,
      attemptCount: 1,
      exitCode: 0,
    });
    expect((await readFile(path.join(fixture.workspacePath, "counter.txt"), "utf8")).trim()).toBe(
      "1",
    );

    const restartedAgent = await LocalAgent.create(fixture.policyPath, options);
    const replay = await restartedAgent.runCommand(input, context);
    expect(replay).toEqual(executed);
    expect((await readFile(path.join(fixture.workspacePath, "counter.txt"), "utf8")).trim()).toBe(
      "1",
    );
  });

  test("reissues confirmation after restart before allowing execution", async () => {
    fixture = await createWritableShellFixture();
    await writeWorkspaceFile(
      fixture.workspacePath,
      "restart-confirmation.txt",
      "before",
    );
    const stateDirectory = path.join(fixture.basePath, "command-invocations");
    const options = enabledOptions(stateDirectory);
    const command = "Set-Content 'restart-confirmation.txt' 'after'";
    const input = {
      workspaceId: "test",
      command,
      shell: "powershell" as const,
      executionMode: "qualified" as const,
      timeoutMs: 120_000,
    };
    const context = { invocationId: "restart-confirmation" };
    const firstAgent = await LocalAgent.create(fixture.policyPath, options);
    const firstConfirmation = await firstAgent.runCommand(input, context);
    if (firstConfirmation.status !== "confirmation_required") {
      throw new Error("Expected the first confirmation.");
    }

    const restartedAgent = await LocalAgent.create(fixture.policyPath, options);
    const renewed = await restartedAgent.runCommand(
      { ...input, confirmationId: firstConfirmation.confirmationId },
      context,
    );
    expect(renewed).toMatchObject({
      status: "confirmation_required",
      executionMode: "qualified",
    });
    if (renewed.status !== "confirmation_required") {
      throw new Error("Expected the renewed confirmation.");
    }
    expect(renewed.confirmationId).not.toBe(firstConfirmation.confirmationId);
    expect(
      await readFile(
        path.join(fixture.workspacePath, "restart-confirmation.txt"),
        "utf8",
      ),
    ).toBe("before");

    await expect(
      restartedAgent.runCommand(
        { ...input, confirmationId: renewed.confirmationId },
        context,
      ),
    ).resolves.toMatchObject({ status: "executed", exitCode: 0 });
    expect(
      (
        await readFile(
          path.join(fixture.workspacePath, "restart-confirmation.txt"),
          "utf8",
        )
      ).trim(),
    ).toBe("after");
  });
  test("returns a structured diagnosis when exit zero fails a postcondition", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(
      fixture.policyPath,
      enabledOptions(path.join(fixture.basePath, "command-invocations")),
    );

    await expect(
      agent.runCommand(
        {
          workspaceId: "test",
          command: "echo 'actual-output'",
          shell: "powershell",
          executionMode: "qualified",
          expectedOutcome: [
            {
              kind: "text_contains",
              stream: "stdout",
              value: "missing-output",
            },
          ],
          timeoutMs: 120_000,
        },
        { invocationId: "failed-postcondition" },
      ),
    ).resolves.toMatchObject({
      status: "executed",
      exitCode: 0,
      executionMode: "qualified",
      corrected: false,
      attemptCount: 1,
      diagnosis: {
        category: "application_failed",
        confidence: 1,
        source: "deterministic",
      },
      postcondition: { passed: false, checked: 1, failed: 1 },
    });
  });
  test("observes direct commands in shadow mode without replacing their execution", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath, {
      qualifiedCommandFeatures: {
        qualifiedExecution: false,
        safeAutoCorrection: false,
        shadowMode: true,
        providerEnabled: false,
      },
      qualifiedCommandWorkspaceAllowlist: ["test"],
      qualifiedInvocationStateDirectory: path.join(
        fixture.basePath,
        "shadow-invocations",
      ),
    });

    await expect(
      agent.runCommand(
        {
          workspaceId: "test",
          command: "node --version",
          shell: "powershell",
          executionMode: "direct",
          timeoutMs: 120_000,
        },
        { invocationId: "shadow-direct" },
      ),
    ).resolves.toMatchObject({
      status: "executed",
      exitCode: 0,
      stdout: expect.stringMatching(/^v[0-9]+/u),
    });
    await agent.awaitQualifiedCommandShadow();
    await expect(agent.qualifiedCommandObservability()).resolves.toMatchObject({
      features: { shadowMode: true, qualifiedExecution: false },
      allowlistEnabled: true,
      metrics: {
        directCalls: 1,
        qualifiedCalls: 0,
        shadowCalls: 1,
        shadowQualified: 1,
      },
    });
  });

  test("blocks qualified execution outside the rollout allowlist", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath, {
      qualifiedCommandFeatures: {
        qualifiedExecution: true,
        safeAutoCorrection: false,
        shadowMode: false,
        providerEnabled: false,
      },
      qualifiedCommandWorkspaceAllowlist: ["other-workspace"],
      qualifiedInvocationStateDirectory: path.join(
        fixture.basePath,
        "allowlist-invocations",
      ),
    });

    await expect(
      agent.runCommand(
        {
          workspaceId: "test",
          command: "node --version",
          shell: "powershell",
          executionMode: "qualified",
          timeoutMs: 120_000,
        },
        { invocationId: "allowlist-blocked" },
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  test("uses an explicitly injected provider and remains deterministic when no provider is configured", async () => {
    fixture = await createWritableShellFixture();
    const stateDirectory = path.join(fixture.basePath, "command-invocations");
    const plan = jest.fn(async (): Promise<ProviderCommandProposal> => ({
      status: "proposal",
      command: "node --version",
      shell: "powershell",
      confidence: 0.99,
    }));
    const provider: QualifiedCommandProvider = {
      identity: { name: "fixture-provider", model: "fixture-model" },
      plan,
      async repair(): Promise<ProviderRepairProposal> {
        return { status: "none" };
      },
      async optimize(): Promise<ProviderCommandProposal> {
        return { status: "none" };
      },
    };
    const input = {
      workspaceId: "test",
      objective: "Report runtime engine metadata",
      executionMode: "qualified" as const,
      timeoutMs: 120_000,
    };

    const providerAgent = await LocalAgent.create(fixture.policyPath, {
      ...enabledOptions(stateDirectory),
      qualifiedCommandFeatures: {
        qualifiedExecution: true,
        safeAutoCorrection: false,
        shadowMode: false,
        providerEnabled: true,
      },
      qualifiedCommandProvider: provider,
    });
    await expect(
      providerAgent.runCommand(input, { invocationId: "provider-injected" }),
    ).resolves.toMatchObject({
      status: "executed",
      exitCode: 0,
      corrected: false,
      attemptCount: 1,
      stdout: expect.stringMatching(/^v[0-9]+/u),
    });
    expect(plan).toHaveBeenCalledTimes(1);

    const deterministicAgent = await LocalAgent.create(
      fixture.policyPath,
      enabledOptions(path.join(fixture.basePath, "deterministic-invocations")),
    );
    await expect(
      deterministicAgent.runCommand(input, { invocationId: "provider-disabled" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  test("reexecutes one repeatable local test after a proven resource lock and replays without a third run", async () => {
    fixture = await createWritableShellFixture();
    await writeWorkspaceFile(
      fixture.workspacePath,
      "package.json",
      JSON.stringify({
        name: "qualified-retry-fixture",
        private: true,
        scripts: { test: "node jest-transient-fixture.js" },
      }),
    );
    await writeWorkspaceFile(
      fixture.workspacePath,
      "jest-transient-fixture.js",
      [
        'const fs = require("node:fs");',
        'const marker = "attempt-count.txt";',
        'const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) + 1 : 1;',
        'fs.writeFileSync(marker, String(count));',
        'if (count === 1) { console.error("resource busy"); process.exit(1); }',
        'console.log("recovered");',
      ].join("\n"),
    );
    const stateDirectory = path.join(fixture.basePath, "command-invocations");
    const agent = await LocalAgent.create(
      fixture.policyPath,
      enabledOptions(stateDirectory, true),
    );
    const commandInput = {
      workspaceId: "test",
      command: "npm test",
      shell: "powershell" as const,
      executionMode: "qualified" as const,
      autoCorrection: "safe" as const,
      timeoutMs: 120_000,
    };
    const context = { invocationId: "repeatable-resource-lock" };

    const result = await agent.runCommand(commandInput, context);
    expect(result).toMatchObject({
      status: "executed",
      exitCode: 0,
      corrected: true,
      attemptCount: 2,
      correction: { applied: true, sanitized: true },
      attempts: [{ attempt: 1, exitCode: 1 }, { attempt: 2, exitCode: 0 }],
    });
    expect(
      (await readFile(path.join(fixture.workspacePath, "attempt-count.txt"), "utf8")).trim(),
    ).toBe("2");

    await expect(agent.runCommand(commandInput, context)).resolves.toEqual(result);
    expect(
      (await readFile(path.join(fixture.workspacePath, "attempt-count.txt"), "utf8")).trim(),
    ).toBe("2");
  });
});

async function createWritableShellFixture(): Promise<Fixture> {
  const created = await createFixture({
    profile: "full-repo-write",
    allowedRoots: ["."],
  });
  await writePolicy(created.policyPath, [
    {
      ...makeWorkspacePolicy(created.workspacePath, {
        profile: "full-repo-write",
        allowedRoots: ["."],
      }),
      allowWrites: ["."],
      allowShell: ["."],
      allowedShells: ["powershell"],
    },
  ]);
  return created;
}
