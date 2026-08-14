import { describe, expect, it, jest } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { QualifiedCommandPlanQualifier } from "../../../src/shell/qualified/command-plan-qualifier.js";
import type {
  PlannerProvider,
  ProviderCommandProposal,
} from "../../../src/shell/qualified/command-provider.js";
import type { CommandContextCollector } from "../../../src/shell/qualified/limited-context-collector.js";
import type { LimitedCommandContext } from "../../../src/shell/qualified/types.js";

describe("qualified planner provider", () => {
  it("uses an optional provider only after deterministic recipes miss", async () => {
    const plan = jest.fn(async (): Promise<ProviderCommandProposal> => ({
      status: "proposal",
      command: "git status --short",
      shell: "cmd",
      confidence: 0.99,
    }));
    const qualifier = createQualifier(context(), provider(plan));

    const result = await qualifier.qualify(workspace(), {
      invocationId: "provider-plan",
      workspaceId: "fixture",
      input: {
        workspaceId: "fixture",
        objective: "Inspect repository changes in concise form",
        timeoutMs: 30_000,
      },
    });

    expect(result).toMatchObject({
      status: "qualified",
      plan: {
        source: "provider",
        objective: "Inspect repository changes in concise form",
        shell: "cmd",
        execution: {
          kind: "argv",
          executable: "git",
          argv: ["status", "--short"],
        },
        effectClass: "pure_read",
        riskClass: "safe",
        provenance: {
          source: "provider",
          provider: "fixture-provider",
          model: "fixture-model",
          sanitized: true,
        },
      },
    });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("blocks provider-generated mutation after local requalification", async () => {
    const qualifier = createQualifier(
      context(),
      provider(async () => ({
        status: "proposal",
        command: "git push origin main",
        shell: "cmd",
        confidence: 0.99,
      })),
    );

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "provider-mutation",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          objective: "Publish current branch",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "UNQUALIFIABLE_EFFECT" }],
    });
  });

  it("preserves the deterministic blocked result when the provider is unavailable", async () => {
    const qualifier = createQualifier(
      context(),
      provider(async () => {
        throw new Error("provider offline");
      }),
    );

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "provider-offline",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          objective: "Unknown custom objective",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "NO_DETERMINISTIC_RECIPE" }],
    });
  });

  it("propagates caller cancellation before any command execution", async () => {
    const controller = new AbortController();
    controller.abort(new AppError("OPERATION_CANCELLED", "planner cancelled"));
    const plan = jest.fn(async (
      _input: Parameters<PlannerProvider["plan"]>[0],
      signal?: AbortSignal,
    ): Promise<ProviderCommandProposal> => {
      expect(signal?.aborted).toBe(true);
      throw signal?.reason;
    });
    const qualifier = createQualifier(context(), provider(plan));

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "provider-cancelled",
        workspaceId: "fixture",
        signal: controller.signal,
        input: {
          workspaceId: "fixture",
          objective: "Unknown custom objective",
          timeoutMs: 30_000,
        },
      }),
    ).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("never calls the provider when a deterministic recipe resolves", async () => {
    const plan = jest.fn(async (): Promise<ProviderCommandProposal> => ({
      status: "none",
    }));
    const qualifier = createQualifier(
      context({
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
      }),
      provider(plan),
    );

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "deterministic-first",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          objective: "Executar os testes",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "qualified",
      recipeId: "package-script.test",
      plan: { source: "deterministic-recipe" },
    });
    expect(plan).not.toHaveBeenCalled();
  });
});

function provider(
  plan: PlannerProvider["plan"],
): PlannerProvider {
  return {
    identity: { name: "fixture-provider", model: "fixture-model" },
    plan,
  };
}

function createQualifier(
  current: LimitedCommandContext,
  planner: PlannerProvider,
): QualifiedCommandPlanQualifier {
  const collector: CommandContextCollector = {
    async collect() {
      return current;
    },
  };
  return new QualifiedCommandPlanQualifier(
    collector,
    undefined,
    undefined,
    planner,
  );
}

function context(
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
    git: { repository: true },
    tools: [
      { name: "cmd", available: true, version: "10" },
      { name: "git", available: true, version: "2.53" },
      { name: "npm", available: true, version: "11" },
    ],
    ...overrides,
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
      maxFileBytes: 64_000,
      maxSearchResults: 100,
      maxSearchSnippetBytes: 20_000,
      maxDiffBytes: 500_000,
      maxListedFiles: 500,
    },
    allowWrites: ["."],
    allowShell: ["."],
    allowedShells: ["cmd"],
  };
}
