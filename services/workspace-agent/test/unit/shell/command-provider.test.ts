import { describe, expect, it } from "@jest/globals";
import {
  applyPlannerProposal,
  plannerProviderInput,
  repairProviderInput,
  sanitizedProviderContext,
} from "../../../src/shell/qualified/command-provider.js";
import type { LimitedCommandContext } from "../../../src/shell/qualified/types.js";
import type { CommandDiagnosis, CommandPlan } from "@vs-code-gpt/shared";

describe("qualified command provider contracts", () => {
  it("sanitizes limited context without exposing absolute paths or Git details", () => {
    const sanitized = sanitizedProviderContext(context());
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toMatchObject({
      logicalCwd: "services/workspace-agent",
      gitRepository: true,
      packageScripts: [
        {
          name: "test",
          commandSha256: "a".repeat(64),
        },
      ],
    });
    expect(serialized).not.toContain("C:\\Users\\ExampleUser");
    expect(serialized).not.toContain("feature/private-branch");
    expect(serialized).not.toContain("npm test --token");
  });

  it("redacts objective secrets and hashes opaque arguments", () => {
    const planner = plannerProviderInput(
      {
        workspaceId: "fixture",
        objective:
          "Run checks with Authorization: Bearer sk-proj-super-secret-value",
        timeoutMs: 30_000,
      },
      context(),
    );
    expect(planner).toBeDefined();
    expect(JSON.stringify(planner)).not.toContain("sk-proj-super-secret-value");

    const repair = repairProviderInput(
      plan(),
      diagnosis(),
      context(),
    );
    expect(repair).toBeDefined();
    expect(repair?.plan.arguments).toEqual([
      { index: 0, kind: "option", value: "--short", length: 7 },
      {
        index: 1,
        kind: "opaque",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        length: "sensitive-file-name.txt".length,
      },
    ]);
    expect(JSON.stringify(repair)).not.toContain("sensitive-file-name.txt");
  });

  it("applies planner proposals without preserving stale confirmation bindings", () => {
    expect(
      applyPlannerProposal(
        {
          workspaceId: "fixture",
          objective: "Inspect status",
          preferredShell: "auto",
          confirmationId: "stale-confirmation",
          timeoutMs: 30_000,
        },
        {
          status: "proposal",
          command: "git status --short",
          shell: "cmd",
          cwd: "services/workspace-agent",
          confidence: 0.99,
        },
      ),
    ).toEqual({
      workspaceId: "fixture",
      objective: "Inspect status",
      command: "git status --short",
      shell: "cmd",
      cwd: "services/workspace-agent",
      timeoutMs: 30_000,
    });
  });
});

function context(): LimitedCommandContext {
  return {
    workspaceId: "fixture",
    logicalCwd: "services/workspace-agent",
    absoluteCwd: "C:\\Users\\ExampleUser\\private\\workspace-agent",
    platform: "win32",
    architecture: "x64",
    allowedShells: ["cmd"],
    markers: [
      {
        path: "package.json",
        kind: "package-manifest",
        sizeBytes: 123,
        sha256: "b".repeat(64),
      },
    ],
    packageMetadata: {
      packageManager: "npm@11",
      scripts: [
        {
          name: "test",
          commandSha256: "a".repeat(64),
          effectClass: "repeatable_local",
          riskClass: "safe",
        },
      ],
    },
    git: {
      repository: true,
      branch: "feature/private-branch",
      dirty: true,
    },
    tools: [
      { name: "cmd", available: true, version: "10" },
      { name: "git", available: true, version: "2.53" },
    ],
  };
}

function plan(): CommandPlan {
  return {
    invocationId: "provider-repair",
    objective: "Inspect status",
    source: "explicit-command",
    shell: "cmd",
    cwd: ".",
    execution: {
      kind: "argv",
      executable: "git",
      argv: ["--short", "sensitive-file-name.txt"],
    },
    timeoutMs: 30_000,
    absoluteDeadline: "2099-01-01T00:00:00.000Z",
    riskClass: "safe",
    effectClass: "pure_read",
    expectedOutcomes: [{ kind: "exit_code", value: 0 }],
    postconditions: [{ kind: "exit_code", value: 0 }],
    fingerprint: "c".repeat(64),
    provenance: { source: "explicit-command", sanitized: true },
  };
}

function diagnosis(): CommandDiagnosis {
  return {
    category: "argument_incompatible",
    confidence: 0.95,
    source: "deterministic",
    message: "unknown option with token=private-value",
  };
}
