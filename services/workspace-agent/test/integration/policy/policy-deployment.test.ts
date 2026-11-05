import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { applyPolicyFile, validatePolicyFile, ReadyReviewPolicyGrant } from "../../../src/policy-deployment.js";
import { createFixture, makeWorkspacePolicy, writePolicy } from "../../support/helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 30_000);


describe("narrow Oracle ready-for-review policy administration", () => {
  const grantFixture = async (mergeAllowed = true) => {
    const fixture = await createFixture();
    cleanups.push(() => fixture.cleanup());
    const policy = makeWorkspacePolicy(fixture.workspacePath, { profile: "full-repo-write" });
    policy.id = "mcp-access-stack";
    policy.sourceControl = {
      capabilities: mergeAllowed ? ["github.pull_request.merge"] : ["github.pull_request.read"],
      accountOwners: [], additionalRepositories: [],
    };
    await writePolicy(fixture.policyPath, [policy]);
    await chmod(fixture.policyPath, 0o600);
    const audit = path.join(fixture.basePath, "grant-audit.jsonl");
    const prior = await readFile(fixture.policyPath);
    const expectedPolicySha256 = createHash("sha256").update(prior).digest("hex");
    return { fixture, policy, audit, prior, expectedPolicySha256 };
  };

  it("grants only ready capability, atomically with secure backup, audit and effective reload", async () => {
    const { fixture, policy, audit, prior, expectedPolicySha256 } = await grantFixture();
    let effective = false;
    let reloads = 0;
    const admin = new ReadyReviewPolicyGrant(fixture.policyPath, audit, () => effective, async () => {
      reloads += 1;
      effective = true;
    });
    expect(await admin.inspect()).toMatchObject({ status: "not_granted", effective: false, policySha256: expectedPolicySha256 });
    const operationId = randomUUID();
    const result = await admin.grant({ expectedPolicySha256, operationId, actor: "edge-user-1" });
    expect(result).toMatchObject({ status: "granted", effective: true, backupCreated: true });
    expect(reloads).toBe(1);
    const now = JSON.parse(await readFile(fixture.policyPath, "utf8"));
    expect(now.workspaces[0].sourceControl.capabilities).toEqual([
      "github.pull_request.merge", "github.pull_request.ready",
    ]);
    expect({ ...now.workspaces[0], sourceControl: undefined }).toEqual({
      ...policy, sourceControl: undefined,
    });
    expect(await readFile(`${fixture.policyPath}.backup-ready-${operationId}.json`)).toEqual(prior);
    expect((await stat(fixture.policyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${fixture.policyPath}.backup-ready-${operationId}.json`)).mode & 0o777).toBe(0o600);
    const events = (await readFile(audit, "utf8")).trim().split("\n").map((s) => JSON.parse(s));
    expect(events.map((event) => event.event)).toEqual(["oracle_ready_grant_requested", "oracle_ready_grant_applied"]);
    expect(JSON.stringify(events)).not.toContain("edge-user-1");
    expect(await admin.grant({ expectedPolicySha256, operationId, actor: "edge-user-1" }))
      .toMatchObject({ status: "already_granted", effective: true, backupCreated: false });
    expect(reloads).toBe(1);
  });

  it("rejects stale CAS without modifying policy or writing backup", async () => {
    const { fixture, audit, prior } = await grantFixture();
    const admin = new ReadyReviewPolicyGrant(fixture.policyPath, audit, () => false, async () => undefined);
    const operationId = randomUUID();
    await expect(admin.grant({
      expectedPolicySha256: "f".repeat(64), operationId, actor: "owner",
    })).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    expect(await readFile(fixture.policyPath)).toEqual(prior);
    await expect(stat(`${fixture.policyPath}.backup-ready-${operationId}.json`))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed without the already-authorized merge capability", async () => {
    const { fixture, audit, prior, expectedPolicySha256 } = await grantFixture(false);
    const admin = new ReadyReviewPolicyGrant(fixture.policyPath, audit, () => false, async () => undefined);
    await expect(admin.grant({ expectedPolicySha256, operationId: randomUUID(), actor: "owner" }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await readFile(fixture.policyPath)).toEqual(prior);
  });

  (process.platform === "win32" ? it.skip : it)("rejects overly permissive policy mode or a symlink", async () => {
    const { fixture, audit, expectedPolicySha256 } = await grantFixture();
    const admin = new ReadyReviewPolicyGrant(fixture.policyPath, audit, () => false, async () => undefined);
    await chmod(fixture.policyPath, 0o644);
    await expect(admin.grant({ expectedPolicySha256, operationId: randomUUID(), actor: "owner" }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await chmod(fixture.policyPath, 0o600);
    const link = path.join(fixture.basePath, "policy-link.json");
    await symlink(fixture.policyPath, link);
    const linkedAdmin = new ReadyReviewPolicyGrant(link, audit, () => false, async () => undefined);
    await expect(linkedAdmin.inspect()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("keeps the policy observable after an uncertain in-process reload", async () => {
    const { fixture, audit, expectedPolicySha256 } = await grantFixture();
    const admin = new ReadyReviewPolicyGrant(fixture.policyPath, audit, () => false, async () => {
      throw new Error("synthetic reload failure");
    });
    await expect(admin.grant({ expectedPolicySha256, operationId: randomUUID(), actor: "owner" }))
      .rejects.toThrow("synthetic reload failure");
    await expect(admin.inspect()).resolves.toMatchObject({ status: "granted", effective: false });
  });
});

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
