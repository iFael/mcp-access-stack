import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AppError,
  type CommandPlan,
  type QualifiedRunCommandInput,
  type RunCommandResult,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { QualifiedCommandOrchestrator } from "../../../src/shell/qualified/command-orchestrator.js";
import { QualifiedCommandPlanQualifier } from "../../../src/shell/qualified/command-plan-qualifier.js";
import type {
  ProviderRepairProposal,
  RepairProvider,
} from "../../../src/shell/qualified/command-provider.js";
import { CommandInvocationRegistry } from "../../../src/shell/qualified/invocation-registry.js";
import type {
  LimitedCommandContext,
  QualifiedCommandQualificationRequest,
} from "../../../src/shell/qualified/types.js";
import { ShellService } from "../../../src/shell/service.js";

const directories: string[] = [];
const firstFingerprint = "d".repeat(64);
const secondFingerprint = "e".repeat(64);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "qualified-orchestrator-unit-"),
  );
  directories.push(directory);
  return directory;
}

const workspace: ResolvedWorkspace = {
  id: "project",
  name: "Project",
  rootPath: process.cwd(),
  canonicalRootPath: process.cwd(),
  enabled: true,
  permissionProfile: "full-repo-write",
    confirmationMode: "standard",
  allowedRoots: [
    {
      logicalPath: ".",
      absolutePath: process.cwd(),
      canonicalPath: process.cwd(),
      kind: "directory",
    },
  ],
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
  allowedShells: ["powershell"],
};

const input: QualifiedRunCommandInput = {
  workspaceId: "project",
  command: "echo qualified-ok",
  shell: "powershell",
  executionMode: "qualified",
  timeoutMs: 30_000,
};

function executed(
  overrides: Partial<Extract<RunCommandResult, { status: "executed" }>> = {},
): Extract<RunCommandResult, { status: "executed" }> {
  return {
    status: "executed",
    shell: "powershell",
    cwd: ".",
    exitCode: 0,
    stdout: "qualified-ok",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function plan(
  invocationId: string,
  absoluteDeadline: string,
  overrides: Partial<CommandPlan> = {},
): CommandPlan {
  return {
    invocationId,
    source: "explicit-command",
    shell: "powershell",
    cwd: ".",
    execution: {
      kind: "argv",
      executable: "echo",
      argv: ["qualified-ok"],
    },
    timeoutMs: 30_000,
    absoluteDeadline,
    riskClass: "safe",
    effectClass: "pure_read",
    expectedOutcomes: [{ kind: "exit_code", value: 0 }],
    postconditions: [{ kind: "exit_code", value: 0 }],
    fingerprint: firstFingerprint,
    provenance: { source: "explicit-command", sanitized: true },
    ...overrides,
  };
}

function limitedContext(
  overrides: Partial<LimitedCommandContext> = {},
): LimitedCommandContext {
  return {
    workspaceId: "project",
    logicalCwd: ".",
    absoluteCwd: process.cwd(),
    platform: process.platform,
    architecture: process.arch,
    allowedShells: ["powershell"],
    markers: [],
    git: { repository: false },
    tools: [],
    ...overrides,
  };
}

function qualifier(
  resolve: (
    request: QualifiedCommandQualificationRequest,
    call: number,
  ) => { plan: CommandPlan; context?: LimitedCommandContext } = (request) => ({
    plan: plan(
      request.invocationId,
      request.absoluteDeadline ?? "2099-01-01T00:00:00.000Z",
    ),
  }),
): QualifiedCommandPlanQualifier {
  let calls = 0;
  return {
    qualify: jest.fn(async (
      _workspace: ResolvedWorkspace,
      request: QualifiedCommandQualificationRequest,
    ) => {
      calls += 1;
      const resolved = resolve(request, calls);
      return {
        status: "qualified" as const,
        plan: resolved.plan,
        context: resolved.context ?? limitedContext(),
      };
    }),
  } as unknown as QualifiedCommandPlanQualifier;
}

function prepared(planFingerprint = firstFingerprint) {
  return {
    logicalCwd: ".",
    absoluteCwd: process.cwd(),
    command: "echo qualified-ok",
    planFingerprint,
  };
}

function confirmation(confirmationId = "fresh-confirmation") {
  return {
    status: "confirmation_required" as const,
    shell: "powershell" as const,
    cwd: ".",
    confirmationId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    reasons: ["corrected plan requires confirmation"],
  };
}

function shellService(
  execute: () => Promise<Extract<RunCommandResult, { status: "executed" }>>,
  prepare: (
    plan: CommandPlan,
    confirmationId: string | undefined,
  ) => Promise<ReturnType<typeof prepared> | ReturnType<typeof confirmation>> = async (
    currentPlan,
  ) => prepared(currentPlan.fingerprint),
): ShellService {
  return {
    prepareQualifiedCommand: jest.fn(async (
      _workspace: ResolvedWorkspace,
      currentPlan: CommandPlan,
      confirmationId?: string,
    ) => prepare(currentPlan, confirmationId)),
    executeQualifiedCommand: jest.fn(execute),
  } as unknown as ShellService;
}

function repairProvider(
  repair: RepairProvider["repair"],
): RepairProvider {
  return {
    identity: { name: "fixture-provider", model: "fixture-model" },
    repair,
  };
}

describe("QualifiedCommandOrchestrator", () => {
  it("keeps safe autocorrection dormant when the first attempt succeeds", async () => {
    const execute = jest.fn(async () => executed());
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifier(),
      shellService: shellService(execute),
    });

    await expect(
      orchestrator.run(
        workspace,
        { ...input, autoCorrection: "safe" },
        { invocationId: "safe-success" },
      ),
    ).resolves.toMatchObject({
      status: "executed",
      corrected: false,
      attemptCount: 1,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries one transient read failure and replays the final result without a third execution", async () => {
    const execute = jest
      .fn<() => Promise<Extract<RunCommandResult, { status: "executed" }>>>()
      .mockResolvedValueOnce(
        executed({ exitCode: 1, stdout: "", stderr: "ECONNRESET" }),
      )
      .mockResolvedValueOnce(executed({ stdout: "recovered" }));
    const service = shellService(execute);
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifier(),
      shellService: service,
    });
    const safeInput = { ...input, autoCorrection: "safe" as const };
    const context = { invocationId: "transient-read" };

    const first = await orchestrator.run(workspace, safeInput, context);
    const replay = await orchestrator.run(workspace, safeInput, context);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "executed",
      corrected: true,
      attemptCount: 2,
      exitCode: 0,
      correction: { applied: true, sanitized: true },
      attempts: [
        { attempt: 1, planFingerprint: firstFingerprint, exitCode: 1 },
        { attempt: 2, planFingerprint: firstFingerprint, exitCode: 0 },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("requalifies an equivalent executable alias before the second attempt", async () => {
    const qualifying = qualifier((request, call) => ({
      context: limitedContext({
        tools: [{ name: "npm", available: true, version: "10" }],
      }),
      plan:
        call === 1
          ? plan(request.invocationId, request.absoluteDeadline!, {
              execution: {
                kind: "argv",
                executable: "npm.cmd",
                argv: ["test"],
              },
            })
          : plan(request.invocationId, request.absoluteDeadline!, {
              execution: {
                kind: "argv",
                executable: "npm",
                argv: ["test"],
              },
              fingerprint: secondFingerprint,
            }),
    }));
    const execute = jest
      .fn<() => Promise<Extract<RunCommandResult, { status: "executed" }>>>()
      .mockResolvedValueOnce(
        executed({
          exitCode: 1,
          stdout: "",
          stderr: "npm.cmd is not recognized as an internal or external command",
        }),
      )
      .mockResolvedValueOnce(executed({ stdout: "tests passed" }));
    const service = shellService(execute);
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifying,
      shellService: service,
    });

    const result = await orchestrator.run(
      workspace,
      {
        ...input,
        command: "npm.cmd test",
        autoCorrection: "safe",
      },
      { invocationId: "alias-repair" },
    );

    expect(result).toMatchObject({
      status: "executed",
      corrected: true,
      attemptCount: 2,
      correction: {
        applied: true,
        effectiveCommand: "npm test",
        effectiveShell: "powershell",
      },
      attempts: [
        { attempt: 1, planFingerprint: firstFingerprint },
        { attempt: 2, planFingerprint: secondFingerprint },
      ],
    });
    expect(qualifying.qualify).toHaveBeenCalledTimes(2);
    expect(
      (qualifying.qualify as jest.Mock).mock.calls[1]?.[1],
    ).toMatchObject({
      input: {
        command: "npm 'test'",
        autoCorrection: "off",
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("uses a provider repair only after deterministic repair misses and fully requalifies it", async () => {
    const qualifying = qualifier((request, call) => ({
      context: limitedContext({
        allowedShells: ["powershell", "cmd"],
        tools: [
          { name: "powershell", available: true },
          { name: "cmd", available: true },
          { name: "git", available: true },
        ],
      }),
      plan: plan(request.invocationId, request.absoluteDeadline!, {
        shell: call === 1 ? "powershell" : "cmd",
        execution: { kind: "argv", executable: "git", argv: ["status"] },
        fingerprint: call === 1 ? firstFingerprint : secondFingerprint,
      }),
    }));
    const repair = jest.fn(async (): Promise<ProviderRepairProposal> => ({
      status: "proposal",
      action: "change_shell",
      shell: "cmd",
      confidence: 0.99,
    }));
    const execute = jest
      .fn<() => Promise<Extract<RunCommandResult, { status: "executed" }>>>()
      .mockResolvedValueOnce(
        executed({ exitCode: 1, stdout: "", stderr: "syntax error" }),
      )
      .mockResolvedValueOnce(executed({ shell: "cmd", stdout: "recovered" }));
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifying,
      repairProvider: repairProvider(repair),
      shellService: shellService(execute),
    });

    const result = await orchestrator.run(
      workspace,
      { ...input, autoCorrection: "safe" },
      { invocationId: "provider-shell-repair" },
    );

    expect(result).toMatchObject({
      status: "executed",
      corrected: true,
      attemptCount: 2,
      correction: { applied: true, effectiveShell: "cmd", sanitized: true },
      attempts: [
        { attempt: 1, planFingerprint: firstFingerprint },
        { attempt: 2, planFingerprint: secondFingerprint },
      ],
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(qualifying.qualify).toHaveBeenCalledTimes(2);
    expect((qualifying.qualify as jest.Mock).mock.calls[1]?.[1]).toMatchObject({
      input: { shell: "cmd", autoCorrection: "off" },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps a provider outage as a one-attempt deterministic result", async () => {
    const repair = jest.fn(async (): Promise<ProviderRepairProposal> => {
      throw new Error("provider offline");
    });
    const execute = jest.fn(async () =>
      executed({ exitCode: 1, stdout: "", stderr: "syntax error" }),
    );
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifier(),
      repairProvider: repairProvider(repair),
      shellService: shellService(execute),
    });

    await expect(
      orchestrator.run(
        workspace,
        { ...input, autoCorrection: "safe" },
        { invocationId: "provider-outage" },
      ),
    ).resolves.toMatchObject({
      status: "executed",
      exitCode: 1,
      corrected: false,
      attemptCount: 1,
      correction: { applied: false, sanitized: true },
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the durable first result when cancellation occurs inside the repair provider", async () => {
    const controller = new AbortController();
    const repair = jest.fn(async (): Promise<ProviderRepairProposal> => {
      controller.abort(new AppError("OPERATION_CANCELLED", "repair cancelled"));
      throw controller.signal.reason;
    });
    const registry = new CommandInvocationRegistry({
      stateDirectory: await stateDirectory(),
    });
    const execute = jest.fn(async () =>
      executed({ exitCode: 1, stdout: "", stderr: "syntax error" }),
    );
    const orchestrator = new QualifiedCommandOrchestrator({
      registry,
      qualifier: qualifier(),
      repairProvider: repairProvider(repair),
      shellService: shellService(execute),
    });

    await expect(
      orchestrator.run(
        workspace,
        { ...input, autoCorrection: "safe" },
        { invocationId: "provider-repair-cancelled", signal: controller.signal },
      ),
    ).resolves.toMatchObject({
      status: "executed",
      exitCode: 1,
      corrected: false,
      attemptCount: 1,
    });
    await expect(registry.get("provider-repair-cancelled")).resolves.toMatchObject({
      state: "completed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("blocks a provider repair when full requalification changes the effect to mutable", async () => {
    const qualifying = qualifier((request, call) => ({
      plan: plan(request.invocationId, request.absoluteDeadline!, {
        shell: call === 1 ? "powershell" : "cmd",
        execution: { kind: "argv", executable: "git", argv: ["status"] },
        fingerprint: call === 1 ? firstFingerprint : secondFingerprint,
        ...(call === 1
          ? {}
          : {
              effectClass: "external_mutation" as const,
              riskClass: "confirmation_required" as const,
            }),
      }),
    }));
    const repair = jest.fn(async (): Promise<ProviderRepairProposal> => ({
      status: "proposal",
      action: "change_shell",
      shell: "cmd",
      confidence: 0.99,
    }));
    const execute = jest.fn(async () =>
      executed({ exitCode: 1, stdout: "", stderr: "syntax error" }),
    );
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifying,
      repairProvider: repairProvider(repair),
      shellService: shellService(execute),
    });

    await expect(
      orchestrator.run(
        workspace,
        { ...input, autoCorrection: "safe" },
        { invocationId: "provider-mutable-repair" },
      ),
    ).resolves.toMatchObject({
      status: "executed",
      exitCode: 1,
      corrected: false,
      attemptCount: 1,
      correction: { applied: false, sanitized: true },
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not call the provider when a deterministic repair exists", async () => {
    const repair = jest.fn(async (): Promise<ProviderRepairProposal> => ({
      status: "none",
    }));
    const execute = jest
      .fn<() => Promise<Extract<RunCommandResult, { status: "executed" }>>>()
      .mockResolvedValueOnce(
        executed({ exitCode: 1, stdout: "", stderr: "ECONNRESET" }),
      )
      .mockResolvedValueOnce(executed({ stdout: "recovered" }));
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifier(),
      repairProvider: repairProvider(repair),
      shellService: shellService(execute),
    });

    await expect(
      orchestrator.run(
        workspace,
        { ...input, autoCorrection: "safe" },
        { invocationId: "deterministic-before-provider" },
      ),
    ).resolves.toMatchObject({
      status: "executed",
      corrected: true,
      attemptCount: 2,
    });
    expect(repair).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("invalidates the original confirmation binding and requires a fresh corrected confirmation", async () => {
    const qualifying = qualifier((request, call) => ({
      context: limitedContext({
        tools: [{ name: "npm", available: true }],
      }),
      plan:
        call === 2
          ? plan(request.invocationId, request.absoluteDeadline!, {
              execution: {
                kind: "argv",
                executable: "npm",
                argv: ["test"],
              },
              fingerprint: secondFingerprint,
              riskClass: "confirmation_required",
            })
          : plan(request.invocationId, request.absoluteDeadline!, {
              execution: {
                kind: "argv",
                executable: "npm.cmd",
                argv: ["test"],
              },
            }),
    }));
    const execute = jest
      .fn<() => Promise<Extract<RunCommandResult, { status: "executed" }>>>()
      .mockResolvedValueOnce(
        executed({
          exitCode: 1,
          stdout: "",
          stderr: "npm.cmd is not recognized as an internal or external command",
        }),
      )
      .mockResolvedValueOnce(executed({ stdout: "confirmed repair" }));
    const prepare = jest.fn(async (
      currentPlan: CommandPlan,
      confirmationId: string | undefined,
    ) => {
      if (currentPlan.fingerprint === secondFingerprint && !confirmationId) {
        return confirmation();
      }
      return prepared(currentPlan.fingerprint);
    });
    const service = shellService(execute, prepare);
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifying,
      shellService: service,
    });
    const safeInput = {
      ...input,
      command: "npm.cmd test",
      autoCorrection: "safe" as const,
      confirmationId: "stale-original-confirmation",
    };
    const context = { invocationId: "fresh-repair-confirmation" };

    const requested = await orchestrator.run(workspace, safeInput, context);
    expect(requested).toMatchObject({
      status: "confirmation_required",
      confirmationId: "fresh-confirmation",
      corrected: false,
      attemptCount: 1,
      correction: { applied: false },
    });
    expect(prepare.mock.calls[1]?.[1]).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);

    const result = await orchestrator.run(
      workspace,
      { ...safeInput, confirmationId: "fresh-confirmation" },
      context,
    );
    expect(result).toMatchObject({
      status: "executed",
      corrected: true,
      attemptCount: 2,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("fails closed after restart while a corrected confirmation is pending", async () => {
    const directory = await stateDirectory();
    const qualifying = qualifier((request, call) => ({
      context: limitedContext({ tools: [{ name: "npm", available: true }] }),
      plan:
        call === 2
          ? plan(request.invocationId, request.absoluteDeadline!, {
              execution: { kind: "argv", executable: "npm", argv: ["test"] },
              fingerprint: secondFingerprint,
              riskClass: "confirmation_required",
            })
          : plan(request.invocationId, request.absoluteDeadline!, {
              execution: {
                kind: "argv",
                executable: "npm.cmd",
                argv: ["test"],
              },
            }),
    }));
    const firstExecute = jest.fn(async () =>
      executed({
        exitCode: 1,
        stdout: "",
        stderr: "npm.cmd is not recognized as an internal or external command",
      }),
    );
    const firstAgent = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({ stateDirectory: directory }),
      qualifier: qualifying,
      shellService: shellService(firstExecute, async (currentPlan) =>
        currentPlan.fingerprint === secondFingerprint
          ? confirmation()
          : prepared(currentPlan.fingerprint),
      ),
    });
    const safeInput = {
      ...input,
      command: "npm.cmd test",
      autoCorrection: "safe" as const,
    };
    const context = { invocationId: "restart-repair-confirmation" };

    await expect(firstAgent.run(workspace, safeInput, context)).resolves.toMatchObject({
      status: "confirmation_required",
    });

    const restartedExecute = jest.fn(async () => executed());
    const restarted = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({ stateDirectory: directory }),
      qualifier: qualifier((request) => ({
        plan: plan(request.invocationId, request.absoluteDeadline!, {
          execution: {
            kind: "argv",
            executable: "npm.cmd",
            argv: ["test"],
          },
        }),
      })),
      shellService: shellService(restartedExecute),
    });

    await expect(
      restarted.run(
        workspace,
        { ...safeInput, confirmationId: "fresh-confirmation" },
        context,
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
    expect(restartedExecute).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent retries and executes the first attempt once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = jest.fn(async () => {
      await gate;
      return executed();
    });
    const service = shellService(execute);
    const orchestrator = new QualifiedCommandOrchestrator({
      registry: new CommandInvocationRegistry({
        stateDirectory: await stateDirectory(),
      }),
      qualifier: qualifier(),
      shellService: service,
    });

    const first = orchestrator.run(workspace, input, {
      invocationId: "concurrent-invocation",
    });
    await waitUntil(() => execute.mock.calls.length === 1);
    const retry = orchestrator.run(workspace, input, {
      invocationId: "concurrent-invocation",
    });
    release();

    const [firstResult, retryResult] = await Promise.all([first, retry]);
    expect(firstResult).toEqual(retryResult);
    expect(firstResult).toMatchObject({
      status: "executed",
      executionMode: "qualified",
      corrected: false,
      attemptCount: 1,
      postcondition: { passed: true, checked: 1, failed: 0 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("persists outcome_unknown when execution may have started without a durable result", async () => {
    const execute = jest.fn(async () => {
      throw new AppError("SHELL_FAILED", "transport lost after spawn");
    });
    const directory = await stateDirectory();
    const registry = new CommandInvocationRegistry({ stateDirectory: directory });
    const orchestrator = new QualifiedCommandOrchestrator({
      registry,
      qualifier: qualifier(),
      shellService: shellService(execute),
    });
    const context = { invocationId: "unknown-outcome" };

    await expect(orchestrator.run(workspace, input, context)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN",
    });
    await expect(orchestrator.run(workspace, input, context)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(registry.get("unknown-outcome")).resolves.toMatchObject({
      state: "outcome_unknown",
      response: {
        kind: "error",
        value: { code: "EXECUTION_OUTCOME_UNKNOWN" },
      },
    });
  });

  it("persists a proven pre-spawn shell failure without retrying", async () => {
    const execute = jest.fn(async () => {
      throw new AppError("SHELL_UNAVAILABLE", "missing shell");
    });
    const registry = new CommandInvocationRegistry({
      stateDirectory: await stateDirectory(),
    });
    const orchestrator = new QualifiedCommandOrchestrator({
      registry,
      qualifier: qualifier(),
      shellService: shellService(execute),
    });
    const context = { invocationId: "missing-shell" };

    await expect(orchestrator.run(workspace, input, context)).rejects.toMatchObject({
      code: "SHELL_UNAVAILABLE",
    });
    await expect(orchestrator.run(workspace, input, context)).rejects.toMatchObject({
      code: "SHELL_UNAVAILABLE",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(registry.get("missing-shell")).resolves.toMatchObject({
      state: "blocked",
    });
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for predicate.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
