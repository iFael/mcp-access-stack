import { describe, expect, it } from "@jest/globals";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { QualifiedCommandPlanQualifier } from "../../../src/shell/qualified/command-plan-qualifier.js";
import type { CommandContextCollector } from "../../../src/shell/qualified/limited-context-collector.js";
import { SanitizedRecipeCache } from "../../../src/shell/qualified/sanitized-recipe-cache.js";
import type { LimitedCommandContext } from "../../../src/shell/qualified/types.js";

const now = new Date("2026-08-05T04:00:00.000Z");

describe("qualified recipe cache integration", () => {
  it("requalifies every cache hit and replaces stale context entries", async () => {
    let current = context();
    const collector: CommandContextCollector = {
      async collect() {
        return current;
      },
    };
    const cache = new SanitizedRecipeCache({ now: () => now });
    const qualifier = new QualifiedCommandPlanQualifier(
      collector,
      undefined,
      cache,
    );
    const input = {
      workspaceId: "fixture",
      objective: "Executar os testes",
      timeoutMs: 30_000,
    };

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "cache-miss",
        workspaceId: "fixture",
        now,
        input,
      }),
    ).resolves.toMatchObject({
      status: "qualified",
      recipeId: "package-script.test",
    });
    expect(cache.snapshot()).toMatchObject({
      entries: 1,
      hits: 0,
      misses: 1,
      stores: 1,
    });

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "cache-hit-invalid-postcondition",
        workspaceId: "fixture",
        now,
        input: {
          ...input,
          expectedOutcome: [
            {
              kind: "http_status" as const,
              url: "https://example.invalid/health",
              value: 200,
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "INVALID_POSTCONDITION" }],
    });
    expect(cache.snapshot()).toMatchObject({ hits: 1, stores: 1 });

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "cache-hit-valid",
        workspaceId: "fixture",
        now,
        input,
      }),
    ).resolves.toMatchObject({
      status: "qualified",
      plan: {
        effectClass: "repeatable_local",
        riskClass: "safe",
      },
    });
    expect(cache.snapshot()).toMatchObject({ hits: 2, stores: 1 });

    current = context({
      markers: [
        {
          path: "package.json",
          kind: "package-manifest",
          sha256: "d".repeat(64),
        },
      ],
      packageMetadata: {
        packageManager: "npm@11",
        scripts: [safeScript("e")],
      },
    });

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "cache-stale",
        workspaceId: "fixture",
        now,
        input,
      }),
    ).resolves.toMatchObject({
      status: "qualified",
      recipeId: "package-script.test",
    });
    expect(cache.snapshot()).toMatchObject({
      entries: 1,
      hits: 2,
      misses: 2,
      stale: 1,
      stores: 2,
    });
  });

  it("reclassifies a cached recipe against current package metadata", async () => {
    let current = context();
    const collector: CommandContextCollector = {
      async collect() {
        return current;
      },
    };
    const cache = new SanitizedRecipeCache({ now: () => now });
    const qualifier = new QualifiedCommandPlanQualifier(
      collector,
      undefined,
      cache,
    );
    const input = {
      workspaceId: "fixture",
      objective: "Executar os testes",
      timeoutMs: 30_000,
    };

    await qualifier.qualify(workspace(), {
      invocationId: "prime-cache",
      workspaceId: "fixture",
      now,
      input,
    });

    current = {
      ...current,
      packageMetadata: {
        packageManager: "npm@11",
        scripts: [
          {
            name: "test",
            commandSha256: "c".repeat(64),
            effectClass: "external_mutation",
            riskClass: "confirmation_required",
          },
        ],
      },
    };

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "reclassified-cache-hit",
        workspaceId: "fixture",
        now,
        input,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "NO_DETERMINISTIC_RECIPE" }],
    });
    expect(cache.snapshot()).toMatchObject({ stale: 1, misses: 2 });
  });
});

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
      {
        path: "package.json",
        kind: "package-manifest",
        sha256: "a".repeat(64),
      },
    ],
    packageMetadata: {
      packageManager: "npm@11",
      scripts: [safeScript("b")],
    },
    git: { repository: false },
    tools: [
      { name: "cmd", available: true, version: "10" },
      { name: "npm", available: true, version: "11" },
    ],
    ...overrides,
  };
}

function safeScript(seed: string) {
  return {
    name: "test",
    commandSha256: seed.repeat(64),
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
