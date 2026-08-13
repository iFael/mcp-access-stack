import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { realpath } from "node:fs/promises";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { QualifiedCommandPlanQualifier } from "../../../src/shell/qualified/command-plan-qualifier.js";
import type { CommandContextProbe } from "../../../src/shell/qualified/context-probe.js";
import { LimitedCommandContextCollector } from "../../../src/shell/qualified/limited-context-collector.js";
import { SanitizedRecipeCache } from "../../../src/shell/qualified/sanitized-recipe-cache.js";
import {
  createFixture,
  type Fixture,
  writeWorkspaceFile,
} from "../../support/helpers.js";

jest.setTimeout(60_000);

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe("qualified recipe cache", () => {
  test("hits with unchanged markers and rejects a stale mutating package script", async () => {
    fixture = await createFixture({
      profile: "full-repo-write",
      allowedRoots: ["."],
    });
    await writeWorkspaceFile(
      fixture.workspacePath,
      "package.json",
      JSON.stringify({
        name: "recipe-cache-fixture",
        private: true,
        packageManager: "npm@11.6.1",
        scripts: { test: "node --version" },
      }),
    );
    const resolvedWorkspace = workspace(
      fixture.workspacePath,
      await realpath(fixture.workspacePath),
    );
    const cache = new SanitizedRecipeCache();
    const probe: CommandContextProbe = {
      async getGitContext() {
        return { repository: false };
      },
      async probeTool(name) {
        return {
          name,
          available: name === "cmd" || name === "npm",
          version: "fixture",
        };
      },
    };
    const qualifier = new QualifiedCommandPlanQualifier(
      new LimitedCommandContextCollector(probe),
      undefined,
      cache,
    );
    const input = {
      workspaceId: "fixture",
      objective: "Executar os testes",
      timeoutMs: 30_000,
    };

    const firstQualification = await qualifier.qualify(resolvedWorkspace, {
      invocationId: "recipe-cache-miss",
      workspaceId: "fixture",
      input,
    });
    if (firstQualification.status !== "qualified") {
      throw new Error(JSON.stringify(firstQualification.issues));
    }
    expect(firstQualification).toMatchObject({
      status: "qualified",
      recipeId: "package-script.test",
    });
    expect(cache.snapshot()).toMatchObject({
      misses: 1,
      hits: 0,
      stores: 1,
    });

    await expect(
      qualifier.qualify(resolvedWorkspace, {
        invocationId: "recipe-cache-hit",
        workspaceId: "fixture",
        input,
      }),
    ).resolves.toMatchObject({
      status: "qualified",
      recipeId: "package-script.test",
    });
    expect(cache.snapshot()).toMatchObject({
      misses: 1,
      hits: 1,
      stores: 1,
    });

    await writeWorkspaceFile(
      fixture.workspacePath,
      "package.json",
      JSON.stringify({
        name: "recipe-cache-fixture",
        private: true,
        packageManager: "npm@11.6.1",
        scripts: { test: "npm publish" },
      }),
    );

    await expect(
      qualifier.qualify(resolvedWorkspace, {
        invocationId: "recipe-cache-stale",
        workspaceId: "fixture",
        input,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "NO_DETERMINISTIC_RECIPE" }],
    });
    expect(cache.snapshot()).toMatchObject({
      entries: 0,
      misses: 2,
      hits: 1,
      stale: 1,
      stores: 1,
    });
  });
});

function workspace(
  rootPath: string,
  canonicalRootPath: string,
): ResolvedWorkspace {
  return {
    id: "fixture",
    name: "Fixture",
    rootPath,
    canonicalRootPath,
    enabled: true,
    permissionProfile: "full-repo-write",
    allowedRoots: [
      {
        logicalPath: ".",
        absolutePath: rootPath,
        canonicalPath: canonicalRootPath,
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
