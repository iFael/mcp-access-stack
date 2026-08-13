import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { applyPolicyFile, validatePolicyFile } from "../../../src/policy-deployment.js";
import { createFixture, makeWorkspacePolicy, writePolicy } from "../../support/helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 30_000);

describe("policy deployment", () => {
  it("validates a complete policy before deployment", async () => {
    const fixture = await createFixture();
    cleanups.push(() => fixture.cleanup());

    const result = await validatePolicyFile(fixture.policyPath);

    expect(result.workspaceCount).toBe(1);
    expect(result.path).toBe(path.resolve(fixture.policyPath));
  });

  it("does not replace the active policy when the candidate is invalid", async () => {
    const fixture = await createFixture();
    cleanups.push(() => fixture.cleanup());
    const candidatePath = path.join(fixture.basePath, "candidate.json");
    const targetPath = path.join(fixture.basePath, "active.json");
    const original = await readFile(fixture.policyPath, "utf8");
    await writeFile(targetPath, original, "utf8");
    await writeFile(candidatePath, "{invalid", "utf8");

    await expect(applyPolicyFile(candidatePath, targetPath)).rejects.toMatchObject({
      code: "POLICY_INVALID",
    });

    expect(await readFile(targetPath, "utf8")).toBe(original);
  });

  it("atomically replaces a valid policy and preserves backups", async () => {
    const fixture = await createFixture();
    cleanups.push(() => fixture.cleanup());
    const candidatePath = path.join(fixture.basePath, "candidate.json");
    const targetPath = path.join(fixture.basePath, "active.json");
    const original = await readFile(fixture.policyPath, "utf8");
    await writeFile(targetPath, original, "utf8");
    await writePolicy(candidatePath, [
      makeWorkspacePolicy(fixture.workspacePath, { profile: "full-repo-readonly" }),
    ]);

    const result = await applyPolicyFile(candidatePath, targetPath);

    expect(result.workspaceCount).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath!, "utf8")).toBe(original);
    expect(await readFile(`${targetPath}.last-known-good.json`, "utf8")).toBe(original);
    expect(await readFile(targetPath, "utf8")).toBe(await readFile(candidatePath, "utf8"));
  });
});
