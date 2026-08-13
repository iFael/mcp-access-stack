import { describe, expect, it } from "@jest/globals";
import type {
  CommandDiagnosis,
  CommandPlan,
  QualifiedRunCommandInput,
} from "@vs-code-gpt/shared";
import {
  hasRequiredRepairEvidence,
  proposeDeterministicRepair,
} from "../../../src/shell/qualified/deterministic-repair.js";
import type { LimitedCommandContext } from "../../../src/shell/qualified/types.js";

const input: QualifiedRunCommandInput = {
  workspaceId: "project",
  command: "git status",
  shell: "powershell",
  executionMode: "qualified",
  autoCorrection: "safe",
  confirmationId: "old-confirmation",
  timeoutMs: 30_000,
};

function plan(overrides: Partial<CommandPlan> = {}): CommandPlan {
  return {
    invocationId: "repair",
    source: "explicit-command",
    shell: "powershell",
    cwd: ".",
    execution: { kind: "argv", executable: "git", argv: ["status"] },
    timeoutMs: 30_000,
    absoluteDeadline: "2099-01-01T00:00:00.000Z",
    riskClass: "safe",
    effectClass: "pure_read",
    expectedOutcomes: [{ kind: "exit_code", value: 0 }],
    postconditions: [{ kind: "exit_code", value: 0 }],
    fingerprint: "a".repeat(64),
    provenance: { source: "explicit-command", sanitized: true },
    ...overrides,
  };
}

function context(
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

function diagnosis(category: CommandDiagnosis["category"]): CommandDiagnosis {
  return {
    category,
    confidence: 0.99,
    source: "deterministic",
  };
}

describe("deterministic command repair", () => {
  it("retries a transient pure read without carrying the consumed confirmation", () => {
    const proposal = proposeDeterministicRepair(
      input,
      plan(),
      diagnosis("transient_failure"),
      context(),
    );

    expect(proposal).toMatchObject({
      ruleId: "retry.transient-read",
      confidence: 0.95,
      bindingChanged: false,
      correctedInput: {
        command: "git status",
        autoCorrection: "off",
      },
    });
    expect(proposal?.correctedInput).not.toHaveProperty("confirmationId");
  });

  it("allows a bounded resource-lock retry for repeatable local work", () => {
    expect(
      proposeDeterministicRepair(
        input,
        plan({ effectClass: "repeatable_local" }),
        diagnosis("resource_locked"),
        context(),
      ),
    ).toMatchObject({
      ruleId: "retry.resource-lock",
      waitBeforeRetryMs: 100,
      bindingChanged: false,
    });
  });

  it("does not retry a generic transient failure for repeatable local work", () => {
    expect(
      proposeDeterministicRepair(
        input,
        plan({ effectClass: "repeatable_local" }),
        diagnosis("transient_failure"),
        context(),
      ),
    ).toBeNull();
  });

  it("replaces only a proven equivalent executable alias", () => {
    const proposal = proposeDeterministicRepair(
      { ...input, command: "npm.cmd test" },
      plan({
        execution: { kind: "argv", executable: "npm.cmd", argv: ["test"] },
      }),
      diagnosis("executable_unavailable"),
      context({ tools: [{ name: "npm", available: true }] }),
    );

    expect(proposal).toMatchObject({
      ruleId: "executable.equivalent-windows-alias",
      confidence: 0.99,
      bindingChanged: true,
      correctedInput: {
        command: "npm 'test'",
        shell: "powershell",
      },
    });
    expect(
      proposeDeterministicRepair(
        { ...input, command: "npm.cmd test" },
        plan({
          execution: {
            kind: "argv",
            executable: "npm.cmd",
            argv: ["test"],
          },
        }),
        diagnosis("executable_unavailable"),
        context(),
      ),
    ).toBeNull();
  });

  it("requires package evidence before accepting an authorized root correction", () => {
    const proposal = proposeDeterministicRepair(
      { ...input, command: "npm test", cwd: "packages/core" },
      plan({
        cwd: "packages/core",
        execution: { kind: "argv", executable: "npm", argv: ["test"] },
      }),
      diagnosis("wrong_working_directory"),
      context(),
    );
    expect(proposal).toMatchObject({
      ruleId: "cwd.authorized-package-root",
      correctedInput: { cwd: "." },
      requiredEvidence: "package-root",
    });
    expect(hasRequiredRepairEvidence(proposal!, context())).toBe(false);
    expect(
      hasRequiredRepairEvidence(
        proposal!,
        context({ packageMetadata: { scripts: [] } }),
      ),
    ).toBe(true);
  });

  it("never proposes credential, permission or unknown repairs", () => {
    for (const category of [
      "authentication_failed",
      "authorization_failed",
      "permission_denied",
      "unclassified",
    ] as const) {
      expect(
        proposeDeterministicRepair(input, plan(), diagnosis(category), context()),
      ).toBeNull();
    }
  });
});
