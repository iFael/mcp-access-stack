import { describe, expect, test } from "@jest/globals";
import { workspaceDependencyInstallInputSchema, relayOperations, relayResultSchemas, startBackgroundTaskResultSchema } from "../src/index.js";

describe("typed dependency install contract", () => {
  const resolve = { workspaceId: "repo", root: "fixtures/editor", operationId: "d568cbf7-830a-4be6-9ba7-7268654f3d2a",
    action: "resolve", expectedManifestSha256: "a".repeat(64), expectedLockSha256: null };
  test("requires an exact subdirectory, operation ID, manifest and action-specific lock hash", () => {
    expect(workspaceDependencyInstallInputSchema.safeParse(resolve).success).toBe(true);
    expect(workspaceDependencyInstallInputSchema.safeParse({ ...resolve, action: "install", expectedLockSha256: "b".repeat(64) }).success).toBe(true);
    for (const bad of [{ root: "." }, { root: "/tmp/a" }, { root: "a/../b" }, { root: "a\\b" },
      { operationId: "arbitrary" }, { expectedManifestSha256: "invalid" }, { action: "install" },
      { expectedLockSha256: "b".repeat(64) }, { command: "npm install" }, { packages: ["foo"] }]) {
      expect(workspaceDependencyInstallInputSchema.safeParse({ ...resolve, ...bad }).success).toBe(false);
    }
  });
  test("uses the existing persisted task result contract", () => {
    expect(relayOperations).toContain("workspaceInstallDependencies");
    expect(relayResultSchemas.workspaceInstallDependencies).toBe(startBackgroundTaskResultSchema);
  });
});
