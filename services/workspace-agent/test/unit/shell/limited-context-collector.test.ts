import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import type { CommandContextProbe } from "../../../src/shell/qualified/context-probe.js";
import { LimitedCommandContextCollector } from "../../../src/shell/qualified/limited-context-collector.js";

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe("limited command context collector", () => {
  it("collects only bounded manifest metadata and sanitized script classifications", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "qualified-context-"));
    await writeFile(
      path.join(temporaryRoot, "package.json"),
      JSON.stringify({
        name: "fixture",
        packageManager: "npm@11.6.1",
        privateSecret: "must-not-leak",
        scripts: {
          test: "node ./node_modules/jest/bin/jest.js --runInBand",
          build: "tsc -p tsconfig.json",
          publish: "npm publish",
        },
      }),
      "utf8",
    );
    await writeFile(path.join(temporaryRoot, "AGENTS.md"), "private instructions", "utf8");
    const canonicalRoot = await realpath(temporaryRoot);
    const workspace = createWorkspace(temporaryRoot, canonicalRoot);
    const probe: CommandContextProbe = {
      async getGitContext() {
        return { repository: true, branch: "feature", dirty: true };
      },
      async probeTool(name) {
        return { name, available: true, version: "fixture-version" };
      },
    };

    const context = await new LimitedCommandContextCollector(probe).collect(
      workspace,
      {
        workspaceId: workspace.id,
        objective: "Executar os testes",
        timeoutMs: 30_000,
      },
    );

    expect(context).toMatchObject({
      workspaceId: "fixture",
      logicalCwd: ".",
      absoluteCwd: canonicalRoot,
      git: { repository: true, branch: "feature", dirty: true },
      packageMetadata: {
        name: "fixture",
        packageManager: "npm@11.6.1",
      },
    });
    expect(context.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "AGENTS.md", kind: "instruction" }),
        expect.objectContaining({ path: "package.json", kind: "package-manifest" }),
      ]),
    );
    expect(context.packageMetadata?.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "test",
          effectClass: "repeatable_local",
          riskClass: "safe",
          commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          name: "publish",
          effectClass: "external_mutation",
          riskClass: "confirmation_required",
        }),
      ]),
    );
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("node_modules/jest");
    expect(serialized).not.toContain("private instructions");
  });

  it("derives the package manager from the lockfile when package.json does not declare it", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "qualified-context-pnpm-"));
    await writeFile(
      path.join(temporaryRoot, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8",
    );
    await writeFile(path.join(temporaryRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf8");
    const canonicalRoot = await realpath(temporaryRoot);
    const probedTools: string[] = [];
    const probe: CommandContextProbe = {
      async getGitContext() {
        return { repository: false };
      },
      async probeTool(name) {
        probedTools.push(name);
        return { name, available: true };
      },
    };

    const context = await new LimitedCommandContextCollector(probe).collect(
      createWorkspace(temporaryRoot, canonicalRoot),
      {
        workspaceId: "fixture",
        objective: "Executar os testes",
        timeoutMs: 30_000,
      },
    );

    expect(context.packageMetadata?.packageManager).toBe("pnpm");
    expect(probedTools).toContain("pnpm");
    expect(probedTools).not.toContain("npm");
  });
});

function createWorkspace(rootPath: string, canonicalRootPath: string): ResolvedWorkspace {
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
      maxFileBytes: 1_000_000,
      maxSearchResults: 100,
      maxSearchSnippetBytes: 10_000,
      maxDiffBytes: 100_000,
      maxListedFiles: 1_000,
    },
    allowWrites: ["."],
    allowShell: ["."],
    allowedShells: ["pwsh", "cmd"],
  };
}
