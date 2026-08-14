import { describe, expect, it } from "@jest/globals";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { QualifiedCommandPlanQualifier } from "../../../src/shell/qualified/command-plan-qualifier.js";
import type { CommandContextCollector } from "../../../src/shell/qualified/limited-context-collector.js";
import type { LimitedCommandContext } from "../../../src/shell/qualified/types.js";

const fixedNow = new Date("2026-08-04T18:00:00.000Z");

describe("qualified command plan qualifier", () => {
  it("qualifies an explicit read-only command and prefers argv execution", async () => {
    const qualifier = createQualifier(baseContext());

    const result = await qualifier.qualify(workspace(), {
      invocationId: "invocation-1",
      workspaceId: "fixture",
      now: fixedNow,
      input: {
        workspaceId: "fixture",
        command: "git status --short",
        executionMode: "qualified",
        preferredShell: "auto",
        timeoutMs: 30_000,
      },
    });

    expect(result).toMatchObject({
      status: "qualified",
      plan: {
        invocationId: "invocation-1",
        source: "explicit-command",
        shell: "cmd",
        cwd: ".",
        execution: {
          kind: "argv",
          executable: "git",
          argv: ["status", "--short"],
        },
        effectClass: "pure_read",
        riskClass: "safe",
        expectedOutcomes: [{ kind: "exit_code", value: 0 }],
        postconditions: [{ kind: "exit_code", value: 0 }],
        absoluteDeadline: "2026-08-04T18:00:30.000Z",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
  });

  it("resolves a safe typed package recipe from an objective", async () => {
    const qualifier = createQualifier(
      baseContext({
        packageMetadata: {
          name: "fixture",
          packageManager: "npm@11.6.1",
          scripts: [
            safeScript("test", "a"),
            safeScript("build", "b"),
          ],
        },
      }),
    );

    const result = await qualifier.qualify(workspace(), {
      invocationId: "invocation-2",
      workspaceId: "fixture",
      now: fixedNow,
      input: {
        workspaceId: "fixture",
        objective: "Executar os testes do pacote",
        timeoutMs: 60_000,
      },
    });

    expect(result).toMatchObject({
      status: "qualified",
      recipeId: "package-script.test",
      plan: {
        source: "deterministic-recipe",
        objective: "Executar os testes do pacote",
        execution: { kind: "argv", executable: "npm", argv: ["test"] },
        effectClass: "repeatable_local",
        riskClass: "safe",
        provenance: {
          source: "deterministic-recipe",
          recipeId: "package-script.test",
          sanitized: true,
        },
      },
    });
  });

  it("uses a specific intent instead of treating validation wording as check", async () => {
    const qualifier = createQualifier(
      baseContext({
        packageMetadata: {
          scripts: [safeScript("test", "a"), safeScript("check", "b")],
        },
      }),
    );

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "invocation-specific-intent",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          objective: "Validar os testes",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "qualified",
      recipeId: "package-script.test",
    });
  });

  it("qualifies Git status from a repository subdirectory without a local .git marker", async () => {
    const qualifier = createQualifier(
      baseContext({
        logicalCwd: "services/workspace-agent",
        absoluteCwd: "C:\\fixture\\services\\workspace-agent",
        markers: [{ path: "package.json", kind: "package-manifest" }],
      }),
    );

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "invocation-git-subdirectory",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          objective: "Verificar o status do Git",
          cwd: "services/workspace-agent",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "qualified",
      recipeId: "git.status",
      plan: {
        cwd: "services/workspace-agent",
        execution: {
          kind: "argv",
          executable: "git",
          argv: ["status", "--short", "--branch"],
        },
      },
    });
  });

  it("blocks ambiguous objectives and unknown command effects", async () => {
    const context = baseContext({
      packageMetadata: {
        scripts: [safeScript("test", "a"), safeScript("build", "b")],
      },
    });
    const qualifier = createQualifier(context);

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "invocation-3",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          objective: "Executar testes e build",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "AMBIGUOUS_DETERMINISTIC_RECIPE" }],
    });

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "invocation-4",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          command: "custom-tool perform operation",
          executionMode: "qualified",
          shell: "cmd",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "UNQUALIFIABLE_EFFECT" }],
    });
  });

  it("does not create recipes from mutating package scripts", async () => {
    const qualifier = createQualifier(
      baseContext({
        packageMetadata: {
          scripts: [
            {
              name: "test",
              commandSha256: "a".repeat(64),
              effectClass: "external_mutation",
              riskClass: "confirmation_required",
            },
          ],
        },
      }),
    );

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "invocation-unsafe-recipe",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          objective: "Executar os testes",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "NO_DETERMINISTIC_RECIPE" }],
    });
  });

  it("blocks postcondition paths outside the authorized workspace scope", async () => {
    const qualifier = createQualifier(baseContext());

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "invocation-invalid-postcondition",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          command: "git status",
          executionMode: "qualified",
          shell: "cmd",
          expectedOutcome: [{ kind: "file_absent", path: "../secret.txt" }],
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "INVALID_POSTCONDITION" }],
    });
  });

  it("binds the plan to the workspace and selected shell", async () => {
    const qualifier = createQualifier(baseContext());

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "invocation-5",
        workspaceId: "other",
        input: {
          workspaceId: "fixture",
          command: "git status",
          executionMode: "qualified",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "WORKSPACE_MISMATCH" }],
    });

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "invocation-6",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          command: "git status",
          executionMode: "qualified",
          shell: "pwsh",
          preferredShell: "cmd",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "SHELL_CONFLICT" }],
    });
  });

  it("produces the same fingerprint for the same qualified input and timestamp", async () => {
    const qualifier = createQualifier(baseContext());
    const request = {
      invocationId: "invocation-stable",
      workspaceId: "fixture",
      now: fixedNow,
      input: {
        workspaceId: "fixture",
        command: "git status",
        executionMode: "qualified" as const,
        shell: "cmd" as const,
        timeoutMs: 30_000,
      },
    };

    const first = await qualifier.qualify(workspace(), request);
    const second = await qualifier.qualify(workspace(), request);

    expect(first.status).toBe("qualified");
    expect(second.status).toBe("qualified");
    if (first.status === "qualified" && second.status === "qualified") {
      expect(first.plan.fingerprint).toBe(second.plan.fingerprint);
    }
  });
});

function createQualifier(context: LimitedCommandContext): QualifiedCommandPlanQualifier {
  const collector: CommandContextCollector = {
    async collect() {
      return context;
    },
  };
  return new QualifiedCommandPlanQualifier(collector);
}

function baseContext(
  overrides: Partial<LimitedCommandContext> = {},
): LimitedCommandContext {
  return {
    workspaceId: "fixture",
    logicalCwd: ".",
    absoluteCwd: "C:\\fixture",
    platform: "win32",
    architecture: "x64",
    allowedShells: ["cmd"],
    markers: [
      { path: ".git", kind: "repository" },
      { path: "package.json", kind: "package-manifest" },
    ],
    git: { repository: true, branch: "feature", dirty: false },
    tools: [
      { name: "cmd", available: true, version: "10" },
      { name: "git", available: true, version: "2" },
      { name: "npm", available: true, version: "11" },
    ],
    ...overrides,
  };
}

function safeScript(name: string, hashSeed: string) {
  return {
    name,
    commandSha256: hashSeed.repeat(64).slice(0, 64),
    effectClass: "repeatable_local" as const,
    riskClass: "safe" as const,
  };
}

function workspace(): ResolvedWorkspace {
  return {
    id: "fixture",
    name: "Fixture",
    rootPath: "C:\\fixture",
    canonicalRootPath: "C:\\fixture",
    enabled: true,
    permissionProfile: "full-repo-write",
    confirmationMode: "standard",
    allowedRoots: [
      {
        logicalPath: ".",
        absolutePath: "C:\\fixture",
        canonicalPath: "C:\\fixture",
        kind: "directory",
      },
    ],
    blockedGlobs: [],
    limits: {
      maxFileBytes: 1_000_000,
      maxSearchResults: 100,
      maxSearchSnippetBytes: 10_000,
      maxDiffBytes: 100_000,
      maxListedFiles: 1_000,
    },
    allowWrites: ["."],
    allowShell: ["."],
    allowedShells: ["cmd"],
  };
}
