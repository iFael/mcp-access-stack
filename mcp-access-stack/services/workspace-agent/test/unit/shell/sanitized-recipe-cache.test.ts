import { describe, expect, it } from "@jest/globals";
import { SanitizedRecipeCache } from "../../../src/shell/qualified/sanitized-recipe-cache.js";
import type {
  DeterministicCommandRecipe,
  LimitedCommandContext,
} from "../../../src/shell/qualified/types.js";

const baseNow = Date.parse("2026-08-05T04:00:00.000Z");

describe("sanitized recipe cache", () => {
  it("stores only hashed lookup metadata and returns a cloned recipe", () => {
    const cache = new SanitizedRecipeCache({
      now: () => new Date(baseNow),
    });
    const input = lookupInput(
      "Execute tests with token=supersecret",
      context(),
    );
    const source = recipe("test");

    expect(cache.store(input, source)).toBe(true);
    const hit = cache.lookup(input);

    expect(hit).toMatchObject({
      status: "hit",
      recipe: { id: "package-script.test" },
    });
    if (hit.status !== "hit") throw new Error("Expected a cache hit.");
    hit.recipe.execution = { kind: "argv", executable: "tampered", argv: [] };
    expect(cache.lookup(input)).toMatchObject({
      status: "hit",
      recipe: {
        execution: { kind: "argv", executable: "npm", argv: ["test"] },
      },
    });

    const metadata = cache.listMetadata();
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({
      keySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      contextSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      recipeId: "package-script.test",
    });
    expect(JSON.stringify(metadata)).not.toContain("supersecret");
    expect(JSON.stringify(metadata)).not.toContain("C:\\Users\\ExampleUser");
    expect(cache.snapshot()).toMatchObject({
      entries: 1,
      hits: 2,
      misses: 0,
      stores: 1,
    });
  });

  it("invalidates the entry when sanitized context markers change", () => {
    const cache = new SanitizedRecipeCache({
      now: () => new Date(baseNow),
    });
    const initial = lookupInput("Executar os testes", context());
    cache.store(initial, recipe("test"));

    const changed = lookupInput(
      "Executar os testes",
      context({
        markers: [
          {
            path: "package.json",
            kind: "package-manifest",
            sha256: "b".repeat(64),
          },
        ],
      }),
    );

    expect(cache.lookup(changed)).toEqual({ status: "stale" });
    expect(cache.snapshot()).toMatchObject({
      entries: 0,
      hits: 0,
      misses: 1,
      stale: 1,
    });
  });

  it("enforces LRU capacity and TTL expiration", () => {
    let nowMs = baseNow;
    const cache = new SanitizedRecipeCache({
      maxEntries: 2,
      ttlMs: 1_000,
      now: () => new Date(nowMs),
    });
    const current = context();

    cache.store(lookupInput("Executar testes", current), recipe("test"));
    nowMs += 10;
    cache.store(lookupInput("Executar build", current), recipe("build"));
    expect(cache.lookup(lookupInput("Executar testes", current))).toMatchObject({
      status: "hit",
    });
    nowMs += 10;
    cache.store(lookupInput("Executar lint", current), recipe("lint"));

    expect(cache.lookup(lookupInput("Executar build", current))).toEqual({
      status: "miss",
    });
    expect(cache.snapshot()).toMatchObject({
      entries: 2,
      evictions: 1,
    });

    nowMs += 1_001;
    expect(cache.snapshot()).toMatchObject({
      entries: 0,
      expirations: 2,
    });
  });

  it("refuses mutable or script-based recipes", () => {
    const cache = new SanitizedRecipeCache();
    const input = lookupInput("Deploy", context());
    const unsafe: DeterministicCommandRecipe = {
      ...recipe("deploy"),
      execution: { kind: "script", script: "npm publish" },
      classification: {
        effectClass: "external_mutation",
        riskClass: "confirmation_required",
        reasons: ["publishes externally"],
      },
    };

    expect(cache.store(input, unsafe)).toBe(false);
    expect(cache.snapshot()).toMatchObject({ entries: 0, stores: 0 });
  });
});

function lookupInput(objective: string, current: LimitedCommandContext) {
  return {
    workspaceId: current.workspaceId,
    logicalCwd: current.logicalCwd,
    objective,
    shellPreference: "cmd" as const,
    context: current,
  };
}

function recipe(name: string): DeterministicCommandRecipe {
  return {
    id: `package-script.${name}`,
    description: `Run package script ${name}.`,
    intent: name === "build" ? "build" : name === "lint" ? "lint" : "test",
    shell: "auto",
    execution: {
      kind: "argv",
      executable: "npm",
      argv: name === "test" ? ["test"] : ["run", name],
    },
    requiredTools: ["npm"],
    requiredMarkers: ["package.json"],
    classification: {
      effectClass: "repeatable_local",
      riskClass: "safe",
      reasons: ["safe package script"],
    },
    defaultPostconditionExitCode: 0,
  };
}

function context(
  overrides: Partial<LimitedCommandContext> = {},
): LimitedCommandContext {
  return {
    workspaceId: "fixture",
    logicalCwd: ".",
    absoluteCwd: "C:\\Users\\ExampleUser\\fixture",
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
      scripts: [
        {
          name: "test",
          commandSha256: "c".repeat(64),
          effectClass: "repeatable_local",
          riskClass: "safe",
        },
      ],
    },
    git: { repository: false },
    tools: [
      { name: "cmd", available: true, version: "10" },
      { name: "npm", available: true, version: "11" },
    ],
    ...overrides,
  };
}
